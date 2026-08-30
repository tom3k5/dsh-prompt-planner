# Analiza rozbudowy prompt_plan (t1–t6)

Raport z kroków t1–t6 planu rozbudowy pluginu `prompt_plan` o funkcje efektywności.
Zasada nadrzędna: **nie budować od zera, jeśli oficjalny plugin DSH już to robi**.

## t1 — Inwentaryzacja obecnych możliwości prompt_plan

Obecny `prompt_plan` (bundle `dsh-prompt-planner`, `lib/index.js`):

- **analiza** promptu (summary, risks, missingInfo)
- **pytania doprecyzowujące** (2–4, przez `ctx.userQuestions.ask`, z fallbackiem)
- **poprawa** promptu (`improvedPrompt` z TBD)
- **dekompozycja** na 4–12 atomowych zadań z `dependsOn`
- **ocena trudności** 1–5
- **routing modeli** (flash/pro + effort) walidowany w katalogu
- **szacunek tokenów** — **własna replika heurystyki** `~4 znaki/token` (duplikuje `dsh-token-meter`)
- **odporny parser JSON** + obsługa ucięcia (retry z większym budżetem)

Środowisko: DSH `@deepseek-ai/dsh@0.1.2-alpha.2`, 56 pakietów workspace.

## t2 — Oficjalne pluginy DSH z funkcjami efektywności

| Plugin | Funkcja | Relevantne dla prompt_plan |
| --- | --- | --- |
| `dsh-token-meter` | `ctx.tokenMeter` — replay-aware pomiar tokenów | **Zastąp własną heurystykę** — dokładniejszy szacunek |
| `dsh-llm-retry` | provider-routed retry | Już działa przez `llm.stream` (transparentne) |
| `dsh-timeout` | deadline/clampTimeout | `timeoutMs` na tool (już wspiera `dsh-tool-call-timeout-policy`) |
| `dsh-tool-call-timeout-policy` | per-tool deadline na `exec.signal` | **Zadeklaruj `timeoutMs`** w `defineTool` |
| `dsh-compaction-basic` | kompaktowanie kontekstu | Nie dotyczy (prompt_plan nie trzyma historii) |
| `dsh-compaction-tool-result-pruner` | przycinanie tool-result | Nie dotyczy |
| `dsh-spill` / `dsh-spill-local` / `dsh-spill-policy` | zapis oversize tekstu do pliku | **Opcja `outputFile`** — plan jako plik, nie ogromny tool-result |
| `dsh-subagent` (+ spawn/fork backends) | delegacja do child agentów | **Wykonanie planu** — delegacja zadań do subagentów |
| `dsh-workflow` | orkiestracja fan-out | Alternatywa dla ręcznego wykonania planu |
| `dsh-goal` / `dsh-goal-round-driver` | cele sesji | Już używane przez harness |
| `dsh-schedule` | after/at/fixed-rate | Nie dotyczy |
| `dsh-plan-mode` | tryb planu z `/plan` | Komplementarne (nie duplikować) |
| `dsh-session-projection-cache` | throttled write-behind | Nie dotyczy |
| `dsh-atomic-write` | `writeFileAtomic` | **Opcja `outputFile`** — atomowy zapis planu |

## t3 — Backlog funkcji efektywności (z kryteriami akceptacji)

| # | Funkcja | Mierzalne kryterium | Build vs Reuse |
| --- | --- | --- | --- |
| F1 | **Wykonanie planu przez subagentów** (`execute: true`) | Zadania planu delegowane do `ctx.subagents` z modelem wg routingu; wynik spójny | **Reuse** `dsh-subagent`, cienki adapter |
| F2 | **Dokładny szacunek tokenów** | Używa `ctx.tokenMeter.estimateMessage` zamiast własnej stałej | **Reuse** `dsh-token-meter` |
| F3 | **Deadline wywołań planowania** | `timeoutMs` w tool; `dsh-tool-call-timeout-policy` przerywa po limicie | **Reuse** `dsh-tool-call-timeout-policy` |
| F4 | **Zapis planu do pliku** (`outputFile`) | Plan zapisany atomowo (`writeFileAtomic`), tool-result zawiera ścieżkę | **Reuse** `dsh-atomic-write` + `ctx.fs` |
| F5 | (odroczone) Cache planów | — | Zbyt złożone na MVP; `dsh-session-projection-cache` gdy zajdzie potrzeba |

## t4 — Analiza build-vs-reuse

- **F1 (wykonanie)**: NIE budować własnej orkiestracji — `dsh-subagent` (`ctx.subagents.start`) już deleguje do child agentów z własnym modelem. prompt_plan tylko mapuje zadania planu na wywołania subagentów.
- **F2 (tokeny)**: Zastąpić własną `estimateTokens()` wywołaniem `ctx.tokenMeter.estimateMessage(...)`; zachować własny fallback gdy `tokenMeter` niedostępny.
- **F3 (deadline)**: Nic nie pisać — `dsh-tool-call-timeout-policy` już zbroi deadline z `timeoutMs` deklarowanego w `defineTool`.
- **F4 (outputFile)**: `ctx.fs.writeText`/`dsh-atomic-write` już istnieje — tylko przekazać ścieżkę.

## t5 — Architektura integracji

```
prompt_plan(prompt, {skipQuestions?, execute?, outputFile?})
   │
   ├─ Faza 1: diagnoza (llm.stream, effort low)          [jak dziś]
   ├─ Faza 2: pytania (userQuestions.ask)                [jak dziś]
   ├─ Faza 3: plan (llm.stream + tokenMeter zamiast heurystyki)  [F2]
   ├─ (opcjonalnie) zapis planu do outputFile            [F4, writeFileAtomic]
   └─ (opcjonalnie execute:true)
        └─ dla każdego zadania wg executionOrder:
             ctx.subagents.start('spawn', { model: task.model, ... })  [F1]
             → zbiera raporty → dołącza executionReport do wyniku
```

Dodatki do schematu narzędzia: `execute` (boolean), `outputFile` (string). `timeoutMs` na `defineTool` (F3).

## t6 — Plan wdrożenia i rollback

- **Wdrożenie**: edycja `lib/index.js` → commit → push → `dsh plugin add` już w profilu (link: live z repo) → restart dsh.
- **Rollback**: `git revert` commita + restart, albo `cordis_run` poprzedniej wersji. Profil linkuje do repo, więc rollback = cofnięcie commita + restart.
- **Kamienie milowe**: (1) F2+F3+F4 (bezpieczne, bez zmian zachowania) → (2) F1 (execute, większa zmiana) → (3) testy.
