# prompt-planner — dynamiczny plugin Cordis (planp-1)

Własny plugin dla DeepSeek Harness: analiza promptu → **pytania doprecyzowujące (2–4) → poprawa → dekompozycja na atomowe
zadania → ocena trudności (1–5) → dobór modelu + reasoning effort z żywego katalogu →
plan realizacji z szacunkami tokenów.**

## Status

- Plugin: `planp-1` (dynamic Cordis plugin, Host-only, bez restartu procesu).
- Aktywne pakiety: `pkg-5` (bieżący) — v4 + faza pytań doprecyzowujących przed przebudową i dekompozycją.
- Kod źródłowy utrzymywany w repozytorium: **github.com/tom3k5/dsh-prompt-planner** (pakiet DSH `lib/index.js` + ta dokumentacja).
- **Przetestowany end-to-end** na prompcie „projekt mikroserwisu do obsługi zgłoszeń serwisowych": 12 zadań, trudności 2–4, modele `deepseek-v4-pro@high` / `deepseek-v4-flash@high` / `deepseek-v4-flash@low`, szacunek ~11 658 tokenów.
- Narzędzie model-facing: `prompt_plan` (zarejestrowane przez `harness.registerTool`).

## Jak używać

W sesji wystarczy poprosić model, np.:

> Użyj narzędzia `prompt_plan` na poniższym prompcie i przedstaw plan realizacji.

Narzędzie `prompt_plan` przyjmuje:
- `prompt` (string, **wymagany**) — prompt do zaplanowania;
- `skipQuestions` (boolean, opcjonalny) — `true` pomija pytania i planuje wprost z podanego promptu.

## Faza pytań (nowość w v5)

1. **Diagnoza** — tani przebieg LLM (effort `low`, budżet 4096→8192) zwraca `analysis` (summary/risks/missingInfo) oraz **2–4 proponowane pytania** (z opcjami odpowiedzi), uszeregowane wg wpływu na wynik.
2. **Pytania** — narzędzie pyta użytkownika przez `ctx.userQuestions.ask()` (te same okna co `ask_user_question`). Odpowiedzi trafiają do fazy planowania jako autorytatywny kontekst („User answers…") — TBD w prompcie są nimi rozstrzygane.
3. **Fallback** — gdy nie ma żywego użytkownika (subagent, `DELEGATED_CALLER`) albo użytkownik odwoła, plugin **kontynuuje bez pytań** i raportuje powód w polu `clarification.skippedReason`. Żaden błąd pytań nie przerywa planu.

## Co zwraca (JSON)

| Pole | Opis |
| --- | --- |
| `originalPrompt` | wejściowy prompt (verbatim) |
| `clarification` | `asked`, `count`, `answers[]` (`id`, `selected[]`, `custom?`), `skippedReason?` |
| `analysis` | `summary`, `risks[]`, `missingInfo[]` |
| `improvedPrompt` | przepisany prompt (rola, cel, kroki, format, kryteria akceptacji) |
| `taskCount` / `executionOrder` | liczba zadań i kolejność wykonania (sortowanie topologiczne po `dependsOn`) |
| `tasks[]` | per zadanie: `id`, `title`, `description`, `difficulty` (1–5), `dependsOn[]`, `deliverable`, `model {provider, model, reasoningEffort}`, `tokens {inputTokens, outputBudgetTokens, totalEstimated}` |
| `tokenEstimate` | sumaryczne `totalInputTokens`, `totalOutputBudgetTokens`, `totalEstimated` |
| `modelsUsed` | unikalne pary `model@effort` użyte w planie |
| `catalog` | modele z `llm.listModels(provider)` |

## Routing modeli (trudność → model@effort)

| Trudność | Model | Effort |
| --- | --- | --- |
| 1 (trywialne) | `deepseek-v4-flash` | `off` |
| 2 (proste) | `deepseek-v4-flash` | `low` |
| 3 (standardowe) | `deepseek-v4-flash` | `high` |
| 4 (złożone) | `deepseek-v4-pro` | `high` |
| 5 (bardzo trudne) | `deepseek-v4-pro` | `max` |

Effort walidowany przez `llm.resolveModelInfo(...).reasoning.efforts`; niedostępny effort
spada do `defaultEffort` modelu. Provider domyślny: `deepseek-official` (z
`agentDefaultModel.currentSelection()`).

## Szacowanie tokenów

Heurystyka spójna z `dsh-token-meter`: ~4 znaki/token + stały narzut strukturalny
(3 na blok, 4 na rolę wiadomości). `outputBudgetTokens` rośnie z trudnością
(128/256/512/1024/2048). Są to **szacunki**, nie dane z providera.

## Architektura

1. `execute(args, exec)` — walidacja promptu, odczyt `agentDefaultModel`, `llm.listModels(provider)`.
2. **Faza 1** `diagnoseSystem()` — tani strumień `llm.stream` (effort low, 4096→8192): analysis + proponowane pytania.
3. **Faza 2** `userQuestions.ask()` — pytania do użytkownika (z fallbackiem: `DELEGATED_CALLER`/brak providera → kontynuacja bez odpowiedzi, `skipQuestions=true` pomija).
4. **Faza 3** `planSystem()` — pełny strumień `llm.stream` (32768 → retry 65536 + effort off): analiza + improvedPrompt + tasks[] z odpowiedziami użytkownika jako kontekstem.
5. `extractJson()` — ekstrakcja obiektu JSON świadoma stringów/zagnieżdżenia (usuwa fenced code block, znajduje parę `{`…`}`).
6. `repairJson()` — naprawa typowych wad: trailing commas, surowe nowe linie/taby wewnątrz stringów; fallback do `JSON.parse`.
7. Wzbogacenie: `pickRoute(difficulty, models)` + `validateRoute(...)`, `costForTask(...)`, `orderTasks(...)` (topologiczny).

## Wersje (immutable packages)

| Package | Zmiana |
| --- | --- |
| `pkg-1` | pierwsza wersja (miała `purpose: 'session-title'` — usuwała thinking; zastąpiona) |
| `pkg-2` | usunięty `purpose`, dodana walidacja effortów |
| `pkg-3` | odporny parser/naprawa JSON |
| `pkg-4` | obsługa ucięcia: `maxTokens` 32768 → retry 65536 + effort off, `finish` reason, limit 4–12 zadań, zwięzłe opisy |
| `pkg-5` | **faza pytań**: tania diagnoza (2–4 pytania z opcjami) → `userQuestions.ask()` → plan z odpowiedziami jako kontekstem; fallback `DELEGATED_CALLER`/`skipQuestions`; param `skipQuestions` (bieżący) |

## Zarządzanie cyklem życia

- Stop: `cordis_stop(planp-1)` — zatrzymuje efekty, zachowuje pakiety.
- Update/rollback: `cordis_run(planp-1, pkg-N, update|run)`.
- Usunięcie: `cordis_undefine(planp-1)` — trwałe, tylko gdy już niepotrzebny.
