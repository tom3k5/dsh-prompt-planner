// dsh-prompt-planner — host half (Node).
// Registers the `prompt_plan` model-facing tool: analyze a prompt, ask the
// user 2-4 clarifying questions when the intent is ambiguous, then improve
// the prompt, decompose it into atomic tasks, rate each task's difficulty
// (1-5), pick the best available model + reasoning effort from the live
// catalog, and return an execution plan with token estimates.
//
// Plain JavaScript ESM, no build step. Loaded by the DSH host runner.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir, unlink, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

export const name = 'prompt-planner'

// Hard dependencies: Cordis waits until these services exist before applying,
// so the tool is registered exactly once the LLM and tool registries are up.
export const inject = ['llm', 'tools']

export function apply(ctx) {
  const llm = ctx.llm
  const tokenMeter = ctx.get('tokenMeter')

  // ── szacowanie tokenów: preferuj ctx.tokenMeter (oficjalna heurystyka), fallback ──
  const CHARS_PER_TOKEN = 4
  const BLOCK_OVERHEAD = 3
  const ROLE_OVERHEAD = 4
  function estimateTokens(text) {
    if (tokenMeter !== undefined && typeof tokenMeter.estimateMessage === 'function') {
      try {
        return tokenMeter.estimateMessage({ content: [{ type: 'text', text: String(text || '') }] })
      } catch (e) { /* fall through to local heuristic */ }
    }
    return Math.ceil(String(text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }

  // ── odporny ekstraktor JSON: świadomy stringów i zagnieżdżenia ──
  function extractJson(raw) {
    let text = String(raw || '').trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()
    const start = text.indexOf('{')
    if (start === -1) throw new Error('prompt-planner: LLM did not return a JSON object')
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) throw new Error('prompt-planner: LLM JSON object is not closed (output length ' + text.length + ')')
    return repairJson(text.slice(start, end + 1))
  }

  function repairJson(json) {
    try { return JSON.parse(json) } catch (e) { /* fall through to repairs */ }
    let fixed = json.replace(/,([\s]*[}\]])/g, '$1')
    fixed = escapeRawControls(fixed)
    try { return JSON.parse(fixed) } catch (e) { /* fall through */ }
    throw new Error('prompt-planner: LLM JSON could not be repaired: ' + e.message)
  }

  function escapeRawControls(text) {
    let out = ''
    let inStr = false
    let esc = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) { out += c; esc = false; continue }
        if (c === '\\') { out += c; esc = true; continue }
        if (c === '"') { inStr = false; out += c; continue }
        if (c === '\r') {
          if (text[i + 1] === '\n') { out += '\\n'; i++; continue }
          out += '\\r'; continue
        }
        if (c === '\n') { out += '\\n'; continue }
        if (c === '\t') { out += '\\t'; continue }
        out += c; continue
      }
      if (c === '"') inStr = true
      out += c
    }
    return out
  }

  // ── model routing: trudność 1..5 → (model, effort) ──
  function pickRoute(difficulty, models) {
    const flash = models.find(m => /flash/i.test(m.id) && !/vision/i.test(m.id)) || { id: 'deepseek-v4-flash' }
    const pro = models.find(m => /pro/i.test(m.id)) || { id: 'deepseek-v4-pro' }
    if (difficulty <= 2) return { model: flash.id, effort: difficulty === 1 ? 'off' : 'low' }
    if (difficulty === 3) return { model: flash.id, effort: 'high' }
    if (difficulty === 4) return { model: pro.id, effort: 'high' }
    return { model: pro.id, effort: 'max' }
  }

  // ── budowa wiadomości użytkownika (lossless JSON, bez importów) ──
  let msgCounter = 0
  function userMessage(text) {
    msgCounter += 1
    return {
      id: 'prompt-plan-msg-' + msgCounter + '-' + Date.now(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'prompt-planner' },
    }
  }

  // ── strumień LLM z obsługą ucięcia i retry; zwraca parsowalny JSON ──
  async function streamJson(text, route, signal, system, attempts) {
    const messages = [userMessage(text)]
    let lastError = null
    for (const attempt of attempts) {
      let out = ''
      let finishKind = 'unknown'
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        reasoningEffort: attempt.effort,
        messages,
        system,
        maxTokens: attempt.maxTokens,
        signal,
      })) {
        if (chunk.type === 'text-delta') out += chunk.text
        else if (chunk.type === 'finish') finishKind = chunk.reason && chunk.reason.kind
      }
      try {
        return extractJson(out)
      } catch (e) {
        lastError = e
        if (finishKind !== 'max-tokens' && finishKind !== 'unknown') {
          throw new Error('prompt-planner: ' + e.message + ' (finish: ' + finishKind + ')')
        }
      }
    }
    throw new Error('prompt-planner: LLM output truncated on both attempts; last: ' + (lastError && lastError.message))
  }

  // ── FAZA 1: tania diagnoza — summary, risks, missingInfo + proponowane pytania ──
  function diagnoseSystem() {
    return [
      'You are a senior prompt engineer. Analyze the user\'s prompt to prepare a clarification interview. Produce ONLY a strict JSON object with this exact shape:',
      '{',
      '  "analysis": {',
      '    "summary": "one-paragraph understanding of the intent",',
      '    "risks": ["concise list of ambiguity/quality risks"],',
      '    "missingInfo": ["facts or constraints the user did not provide"]',
      '  },',
      '  "questions": [',
      '    {',
      '      "id": "q1",',
      '      "question": "clear, specific question in the user\'s language that would remove the biggest ambiguity",',
      '      "options": [ { "label": "short answer option", "description": "optional one-sentence tradeoff" } ]',
      '    },',
      '  ]',
      '}',
      'Rules: propose 2 to 4 questions, ordered by impact on the result, covering the most important missingInfo/risks. Each question must be answerable in seconds (prefer options over free text; 2-4 options each). Do not ask about things already stated in the prompt. Do not invent constraints. JSON rules: output ONLY the JSON object, no fences, no commentary; every string single-line; no trailing commas; escape inner quotes.',
    ].join('\n')
  }

  // ── FAZA 3: pełny plan z odpowiedziami jako kontekstem ──
  function planSystem() {
    return [
      'You are a senior prompt engineer and task planner. Analyze the user\'s prompt and produce ONLY a strict JSON object with this exact shape:',
      '{',
      '  "analysis": {',
      '    "summary": "one-paragraph understanding of the intent",',
      '    "intentPreserved": true,',
      '    "risks": ["concise list of ambiguity/quality risks"],',
      '    "missingInfo": ["facts or constraints still unknown"]',
      '  },',
      '  "improvedPrompt": "rewritten prompt: explicit role, goal, steps, output format, acceptance criteria, boundary conditions; keep the original intent and language; do not invent facts; use (TBD: ...) placeholders",',
      '  "tasks": [',
      '    {',
      '      "id": "t1",',
      '      "title": "short name",',
      '      "description": "atomic, single-responsibility task, executable on its own",',
      '      "difficulty": 1,',
      '      "dependsOn": [],',
      '      "deliverable": "what this task produces"',
      '    },',
      '  ]',
      '}',
      'Rules: decompose the whole prompt into the smallest atomic tasks (4-12). difficulty is 1 (trivial) to 5 (very hard): 1-2 mechanical/rote, 3 standard reasoning or code, 4 complex multi-step reasoning/refactoring/analysis, 5 research-grade, proofs, security, large architecture. dependsOn lists task ids that must finish first. Every task must have a deliverable. Treat any "User answers" section as authoritative clarification of the original prompt: resolve TBD items with those answers when they fit, and incorporate them into the improvedPrompt.',
      'JSON rules: output ONLY the JSON object, no markdown fences, no commentary, no trailing text. Every string value must be single-line (no literal line breaks inside strings; use spaces instead). No trailing commas. Escape inner double quotes as \\\" or use single quotes inside text. Valid JSON only. Keep descriptions concise (max ~120 chars each) to stay well under the output budget.',
    ].join('\n')
  }

  // ── walidacja effortu względem katalogu modelu ──
  async function validateRoute(provider, model, effort) {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info && info.reasoning && info.reasoning.efforts
      if (Array.isArray(efforts) && efforts.length > 0) {
        const ids = efforts.map(e => e.id)
        if (!ids.includes(effort)) {
          const fallback = info.reasoning.defaultEffort || ids[0]
          return { model, reasoningEffort: fallback, reason: 'effort ' + effort + ' unsupported, fell back to ' + fallback }
        }
      }
    } catch (e) { /* catalog advisory; keep the picked route */ }
    return { model, reasoningEffort: effort }
  }

  // ── szacowanie kosztu wykonania zadania ──
  function costForTask(task, improvedPrompt) {
    const input = estimateTokens(improvedPrompt) + estimateTokens(task.title + ' ' + task.description) + ROLE_OVERHEAD
    const outputBudget = [128, 256, 512, 1024, 2048][Math.min(4, Math.max(0, task.difficulty - 1))]
    return { inputTokens: input, outputBudgetTokens: outputBudget, totalEstimated: input + outputBudget }
  }

  // ── sortowanie topologiczne po dependsOn ──
  function orderTasks(tasks) {
    const byId = new Map(tasks.map(t => [t.id, t]))
    const done = new Set()
    const ordered = []
    const visit = (t) => {
      if (done.has(t.id)) return
      done.add(t.id)
      for (const dep of t.dependsOn || []) {
        const d = byId.get(dep)
        if (d) visit(d)
      }
      ordered.push(t)
    }
    for (const t of tasks) visit(t)
    return ordered
  }

  // ── snapshot plików workspace (ścieżki bezwzględne) przed wykonaniem ──
  async function snapshotWorkspace(root) {
    const files = new Set()
    const stack = [root]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (e) { continue }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) files.add(full)
      }
    }
    return files
  }

  // ── usuń pliki utworzone podczas wykonania (nie było ich przed) ──
  async function cleanupNewFiles(before, after, workspaceRoot) {
    const removed = []
    const failed = []
    for (const file of after) {
      if (before.has(file)) continue
      if (workspaceRoot !== undefined && !file.startsWith(workspaceRoot + '/')) {
        // nigdy nie ruszaj plików poza workspace
        continue
      }
      try {
        await unlink(file)
        removed.push(relative(workspaceRoot || process.cwd(), file))
      } catch (e) {
        failed.push(file)
      }
    }
    return { removed, failed }
  }

  const tool = defineTool({
    name: 'prompt_plan',
    description: 'Analyze a prompt, ask the user 2-4 clarifying questions when the intent is ambiguous, then improve the prompt, decompose it into atomic tasks, rate each task\'s difficulty (1-5), pick the best available model + reasoning effort for each task from the live catalog, and return an execution plan with token estimates. Optionally execute the plan by delegating each task to a subagent with its assigned model, and optionally write the plan to a file. Use this before executing a complex or multi-part request to keep quality while minimizing tokens.',
    timeoutMs: 300000,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The user prompt / task description to plan.',
      },
      skipQuestions: {
        type: 'boolean',
        description: 'When true, skip the clarification questions and plan directly from the prompt as given.',
      },
      execute: {
        type: 'boolean',
        description: 'When true, after planning, execute each task by delegating it to a subagent running the task\'s assigned model. Requires the dsh-subagent providers to be mounted.',
      },
      outputFile: {
        type: 'string',
        description: 'Optional workspace path to atomically write the plan JSON to. When set, the tool result contains the path instead of the full plan text.',
      },
      keepArtifacts: {
        type: 'boolean',
        description: 'When true, keep files created by executed subagents in the workspace. Default false: files newly created by this execution run are removed afterwards.',
      },
      reviewPlan: {
        type: 'boolean',
        description: 'When true and a live user is available, after building the plan ask the user to approve it (or provide corrections) before execution/return. Default false: plan is returned directly.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt_plan: prompt must be a non-empty string')
      const skipQuestions = args.skipQuestions === true

      const defaultModel = ctx.get('agentDefaultModel')
      const selection = defaultModel && typeof defaultModel.currentSelection === 'function'
        ? defaultModel.currentSelection()
        : undefined
      const provider = (selection && selection.provider) || 'deepseek-official'

      const models = await llm.listModels(provider)
      const route = {
        provider,
        model: (selection && selection.model) || 'deepseek-v4-pro',
        effort: (selection && selection.reasoningEffort) || 'high',
      }

      // ── FAZA 1: diagnoza (tani przebieg, effort low, mały budżet) ──
      let diagnosis = null
      try {
        diagnosis = await streamJson(prompt, { provider, model: route.model, effort: 'low' }, exec.signal, diagnoseSystem(), [
          { maxTokens: 4096, effort: 'low' },
          { maxTokens: 8192, effort: 'off' },
        ])
      } catch (e) {
        diagnosis = null
      }
      const proposed = Array.isArray(diagnosis && diagnosis.questions) ? diagnosis.questions.slice(0, 4) : []
      const baseAnalysis = (diagnosis && diagnosis.analysis && typeof diagnosis.analysis === 'object') ? diagnosis.analysis : {}

      // ── FAZA 2: pytania do użytkownika (jeśli możliwe i nie pominięte) ──
      // userQuestions odczytywane per-wywołanie (nie w apply): serwis montuje się
      // po prompt-planner, więc odczyt w apply() dawałby undefined na stałe.
      const userQuestions = ctx.get('userQuestions')
      const clarification = { asked: false, count: 0, proposedCount: proposed.length, answers: [], skippedReason: null }
      if (!skipQuestions && proposed.length > 0 && userQuestions !== undefined && typeof userQuestions.ask === 'function') {
        try {
          const answer = await userQuestions.ask({
            questions: proposed.map((q) => ({
              id: String(q.id),
              question: String(q.question),
              ...(typeof q.header === 'string' && q.header) ? { header: q.header } : {},
              ...(Array.isArray(q.options) && q.options.length > 0) ? {
                options: q.options.map((o) => ({
                  label: String(o.label),
                  ...(typeof o.description === 'string' && o.description) ? { description: o.description } : {},
                })),
              } : {},
            })),
            ...(exec.agent !== undefined) ? { agent: exec.agent } : {},
            signal: exec.signal,
          })
          clarification.asked = true
          clarification.answers = (answer.answers || []).map((a) => ({
            id: a.id,
            selected: Array.isArray(a.selected) ? [...a.selected] : [],
            ...(typeof a.custom === 'string' && a.custom) ? { custom: a.custom } : {},
          }))
          clarification.count = clarification.answers.length
        } catch (e) {
          // brak żywego użytkownika (subagent/delegated) lub odwołanie — kontynuuj bez odpowiedzi
          clarification.skippedReason = (e && (e.code || e.message)) || String(e)
        }
      } else if (proposed.length === 0) {
        clarification.skippedReason = 'no questions proposed'
      } else if (skipQuestions) {
        clarification.skippedReason = 'skipQuestions=true'
      } else {
        clarification.skippedReason = 'userQuestions service unavailable'
      }

      // ── FAZA 3: pełny plan (wydzielona, powtarzalna dla reviewPlan) ──
      async function buildPlan(contextText) {
        const plan = await streamJson(contextText, route, exec.signal, planSystem(), [
          { maxTokens: 32768, effort: route.effort },
          { maxTokens: 65536, effort: 'off' },
        ])
        const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
        if (tasks.length === 0) throw new Error('prompt_planner: no tasks were produced')
        const improved = typeof plan.improvedPrompt === 'string' && plan.improvedPrompt.trim()
          ? plan.improvedPrompt.trim()
          : prompt
        const finalAnalysis = (plan.analysis && typeof plan.analysis === 'object') ? plan.analysis : baseAnalysis
        const enriched = []
        for (const t of tasks) {
          const difficulty = Number.isInteger(t.difficulty) && t.difficulty >= 1 && t.difficulty <= 5 ? t.difficulty : 3
          const picked = pickRoute(difficulty, models)
          const validated = await validateRoute(provider, picked.model, picked.effort)
          const cost = costForTask(t, improved)
          enriched.push({
            id: t.id,
            title: t.title,
            description: t.description,
            difficulty,
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
            deliverable: t.deliverable,
            model: { provider, model: validated.model, reasoningEffort: validated.reasoningEffort },
            tokens: cost,
          })
        }
        const ordered = orderTasks(enriched)
        const totalInput = ordered.reduce((s, t) => s + t.tokens.inputTokens, 0)
        const totalOutput = ordered.reduce((s, t) => s + t.tokens.outputBudgetTokens, 0)
        const modelsUsed = [...new Set(ordered.map(t => t.model.model + '@' + t.model.reasoningEffort))]
        return { ordered, improved, finalAnalysis, totalInput, totalOutput, modelsUsed }
      }

      const contextParts = [prompt]
      if (clarification.answers.length > 0) {
        const lines = clarification.answers.map((a) => {
          const parts = []
          if (Array.isArray(a.selected) && a.selected.length > 0) parts.push(a.selected.join('; '))
          if (typeof a.custom === 'string' && a.custom.trim()) parts.push(a.custom.trim())
          return '[' + a.id + '] ' + parts.join(' | ') || ('[' + a.id + '] (no answer)')
        })
        contextParts.push('User answers to clarification questions:\n' + lines.join('\n'))
      }
      let contextText = contextParts.join('\n\n')
      let built = await buildPlan(contextText)

      // ── F5: podgląd planu z możliwością akceptacji/korekty (reviewPlan) ──
      const reviewPlan = args.reviewPlan === true
      if (reviewPlan && userQuestions !== undefined && typeof userQuestions.ask === 'function' && exec.agent !== undefined) {        try {
          const preview = [
            'Proposed plan — please review and approve, or provide corrections:',
            '',
            'Improved prompt:',
            built.improved,
            '',
            'Tasks (' + built.ordered.length + '):',
            ...built.ordered.map((t, i) => (i + 1) + '. [' + t.difficulty + '/5] ' + t.title + ' — ' + t.description + ' (' + t.model.model + '@' + t.model.reasoningEffort + ')'),
          ].join('\n')
          const answer = await userQuestions.ask({
            questions: [{
              id: 'plan-review',
              question: preview,
              options: [
                { label: 'Approve', description: 'Accept the plan as-is and continue.' },
                { label: 'Needs corrections', description: 'Type corrections; the plan will be rebuilt.' },
              ],
            }],
            agent: exec.agent,
            signal: exec.signal,
          })
          const reviewAnswer = (answer.answers || [])[0]
          const corrections = reviewAnswer && typeof reviewAnswer.custom === 'string' && reviewAnswer.custom.trim()
            ? reviewAnswer.custom.trim()
            : ''
          if (corrections !== '') {
            contextParts.push('User corrections to the proposed plan:\n' + corrections)
            contextText = contextParts.join('\n\n')
            built = await buildPlan(contextText)
          }
        } catch (e) {
          // brak żywego użytkownika — pomiń podgląd i kontynuuj
        }
      }

      const { ordered, improved, finalAnalysis, totalInput, totalOutput, modelsUsed } = built

      const result = {
        originalPrompt: prompt,
        clarification,
        analysis: {
          summary: typeof finalAnalysis.summary === 'string' ? finalAnalysis.summary : '',
          risks: Array.isArray(finalAnalysis.risks) ? finalAnalysis.risks : [],
          missingInfo: Array.isArray(finalAnalysis.missingInfo) ? finalAnalysis.missingInfo : [],
        },
        improvedPrompt: improved,
        taskCount: ordered.length,
        executionOrder: ordered.map(t => t.id),
        tasks: ordered,
        tokenEstimate: {
          heuristic: tokenMeter !== undefined ? 'ctx.tokenMeter estimate (fallback: ~4 chars/token + overhead)' : '~4 chars per token + structural overhead',
          totalInputTokens: totalInput,
          totalOutputBudgetTokens: totalOutput,
          totalEstimated: totalInput + totalOutput,
        },
        modelsUsed,
        catalog: models.map(m => ({ id: m.id, name: m.name })),
      }

      // ── F4: opcjonalny zapis planu do pliku (atomowo przez ctx.fs) ──
      const fs = ctx.get('fs')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const outputFile = typeof args.outputFile === 'string' ? args.outputFile.trim() : ''
      if (outputFile !== '' && fs !== undefined && typeof fs.resolve === 'function' && typeof fs.writeText === 'function') {
        // Resolve the per-session policy exactly like the official dsh-tool-fs:
        // the policy (mode + workspace root) must travel with the mutation so the
        // sandboxing backend fences the write against the session's workspace.
        let policy = undefined
        if (sandboxPolicy !== undefined && typeof sandboxPolicy.resolve === 'function') {
          try {
            policy = sandboxPolicy.resolve({
              ...(exec.agent !== undefined && exec.agent.session !== undefined) ? { session: exec.agent.session } : {},
            })
          } catch (e) { /* fall through: unsandboxed backend */ }
        }
        const cwd = policy && typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : undefined
        const target = await fs.resolve(outputFile, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal })
        await fs.writeText(target, JSON.stringify(result, null, 2), undefined, exec.signal, policy)
        result.planFile = outputFile
      } else if (outputFile !== '') {
        result.planFileError = 'fs service unavailable; plan not written to file'
      }

      // ── F1: opcjonalne wykonanie planu przez subagentów ──
      const subagents = ctx.get('subagents')
      const execute = args.execute === true
      const keepArtifacts = args.keepArtifacts === true
      if (execute) {
        if (exec.agent === undefined) {
          result.executionError = 'execute requires a live agent parent (not available in a delegated caller)'
        } else if (subagents === undefined || typeof subagents.start !== 'function') {
          result.executionError = 'ctx.subagents unavailable; cannot execute the plan'
        } else {
          // snapshot workspace przed wykonaniem — do sprzątania artefaktów
          const sandboxForExec = ctx.get('sandboxPolicy')
          const wsRoot = sandboxForExec && typeof sandboxForExec.workspaceRoot === 'string'
            ? sandboxForExec.workspaceRoot
            : undefined
          let before = new Set()
          if (wsRoot !== undefined) {
            try { before = await snapshotWorkspace(wsRoot) } catch (e) { before = new Set() }
          }
          const reports = []
          for (const t of ordered) {
            const promptText = [
              'Task ' + t.id + ': ' + t.title,
              t.description,
              'Deliverable: ' + t.deliverable,
              '',
              'Context (improved prompt): ' + improved,
            ].join('\n')
            try {
              const run = await subagents.start('spawn', {
                label: 'plan-' + t.id + '-' + String(t.title || 'task').slice(0, 40),
                prompt: [{ type: 'text', text: promptText }],
                parent: exec.agent,
                signal: exec.signal,
                agentOptions: {
                  provider,
                  model: t.model.model,
                  reasoningEffort: t.model.reasoningEffort,
                },
              })
              const subResult = await run.result
              const textOut = (subResult && Array.isArray(subResult.output))
                ? subResult.output.map(b => (b && b.type === 'text') ? b.text : '').filter(Boolean).join('\n')
                : ''
              reports.push({
                id: t.id,
                title: t.title,
                model: t.model.model,
                reasoningEffort: t.model.reasoningEffort,
                stopReason: subResult ? subResult.stopReason : 'unknown',
                output: textOut.length > 4000 ? textOut.slice(0, 4000) + '…(truncated)' : textOut,
              })
              if (typeof run.dispose === 'function') await run.dispose()
            } catch (e) {
              reports.push({
                id: t.id,
                title: t.title,
                model: t.model.model,
                reasoningEffort: t.model.reasoningEffort,
                error: (e && (e.message || e.code)) || String(e),
              })
            }
          }
          result.executionReport = {
            executed: reports.filter(r => !r.error).length,
            failed: reports.filter(r => r.error).length,
            reports,
          }
          // ── sprzątanie: usuń nowo utworzone pliki, chyba że keepArtifacts ──
          if (!keepArtifacts && wsRoot !== undefined && before.size > 0) {
            try {
              const after = await snapshotWorkspace(wsRoot)
              const cleanup = await cleanupNewFiles(before, after, wsRoot)
              if (cleanup.removed.length > 0 || cleanup.failed.length > 0) {
                result.cleanup = {
                  removed: cleanup.removed,
                  failed: cleanup.failed,
                  keptBecauseKeepArtifacts: false,
                }
              }
            } catch (e) {
              result.cleanup = { error: (e && e.message) || String(e) }
            }
          } else if (keepArtifacts) {
            result.cleanup = { keptBecauseKeepArtifacts: true }
          }
        }
      }

      return result
    },
  })

  ctx.effect(() => ctx.tools.register(tool))
}
