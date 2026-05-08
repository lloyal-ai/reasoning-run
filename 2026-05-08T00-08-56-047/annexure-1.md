# Annexure 1

**Task:** Survey the landscape of lloyal HDK capabilities and supported frameworks — identify the named agents, skills, and tool abstractions (such as ReAct, reflection, RIG pipelines, and custom tool patterns) that are explicitly documented in the harness documentation.

---

# Lloyal HDK Capabilities Survey

## Named Agents and Abstractions

### 1. **Agent Class** (learn/agents.mdx)
- **Single agent**: `agent` — one inference branch with a system prompt, task, and tool set
- **Parallel agents**: `agentPool` — multiple agents sharing a common KV cache prefix via `withSharedRoot`
- **API**: `useAgent` and `useAgentPool` — compositional hooks for harness construction

**Evidence**:
> "Single agent: agent, Parallel agents: agentPool, useAgent and useAgentPool, Agent Policy, Context pressure, Prefix sharing, Nested results, Events"

### 2. **Branch Lifecycle** (reference/branch-lifecycle.md)
- **Branch.create** — cold start, creates new KV sequence
- **fork / forkSync** — O(1) branch creation for parallelism
- **prefill** — decode tokens into KV cache
- **produce / commit** — generation protocol via `setLogits`/`getLogits`
- **prune / pruneSync** — free KV cells on scope exit

### 3. **Agent Policy** (reference/agent-policy.mdx)
- **`shouldExit`** — pre-generation kill gate
- **`onProduced`** — main decision point (free_text_report vs tool use)
- **`onSettleReject`** — stall-break fallback
- **`shouldExplore`** — explore vs exploit mode
- **`onRecovery`** — scratchpad extraction on kill
- **`resetTick`** — per-tick state reset

## Framework Patterns

### 4. **ReAct Pattern** (examples/react-agent.md)
- **Reason + Act** loop with corpus tools
- **Tools**: `search` (semantic), `grep` (regex), `read_file` (context), `report` (terminal)
- **Workflow**: broad search → targeted grep → context read → report
- **Implementation**: Single `useAgent` call with `DefaultAgentPolicy`

### 5. **Reflection Pattern** (examples/reflection.md)
- **Manual branch lifecycle**: diverge → verify → commit → prune
- **Diverge-based verification** for multi-agent critique
- **Research → draft → critique → revise** cycle

### 6. **RIG Pipelines** (reference/rig/overview.mdx)
- **RIG vs RAG**: Retrieval-Interleaved Generation (multi-hop reasoning)
- **4-Beat Pattern**: Plan → Research → Bridge → Synthesize → Eval
- **Pipeline shape**: `Corpus research → Bridge → Web research → Synthesize`
- **Bridges**: Structure discoveries between sources to direct investigation

### 7. **Custom Pipeline** (guides/custom-pipeline.md)
- **DAG orchestration**: Multi-parent dependencies, skill catalog
- **Custom stages**: Add fact-check, evaluation, or synthesis phases
- **Budget/recovery**: Configure `softLimit`/`hardLimit` for context pressure

### 8. **Custom Source** (guides/custom-source.md)
- **Source<TCtx, TChunk>** abstraction for any searchable system
- **Step-by-step implementation**: Buffering chunks for reranking
- **Grounding tools**: Synthesis from retrieved content

### 9. **Custom Tool** (guides/custom-tool.md)
- **Tool<TArgs>** base class extension
- **Async execution**: `call()` method for external work
- **Recursive tools**: Tools that spawn sub-agents via `agentPool()`
- **ToolContext**: Access peer history for cross-agent deduplication

## Tool Abstractions

### 10. **Tool Interface** (learn/tools.mdx)
- **Tool<TArgs>** — anything an agent can invoke
- **Tool execution model**: Async with `call()` method
- **Tool ordering rules**: GBNF grammar constraints
- **Terminal tool pattern**: `report` as final action
- **Reasoning probes**: Entailment scoring at tool boundaries

### 11. **Skill Catalog** (reference/skill-catalog.mdx)
- **Convention**: List tools grouped by skill at root systemPrompt
- **Per-agent skill request**: Explicit skill invocation per agent
- **Tool amortization**: Shared tool palette across mixed-role pools

### 12. **EntailmentScorer** (reference/search-strategy.mdx)
- **Interface**: `EntailmentScorer` for query scoring
- **Three-query convention**: Original query + sub-questions + steering query
- **Explore vs exploit**: Content boundaries for delegation

## Core Infrastructure

### 13. **Continuous Context Spine** (reference/continuous-context-spine.md)
- **KV state propagation**: Physical mechanics of cascaded research
- **Two spine types**: Session trunk as long-term spine
- **Prefix sharing**: Metadata-only KV share across agent pools

### 14. **KV Pressure** (reference/kv-pressure.mdx)
- **Budget model**: `hardLimit >= nBatch` invariant
- **ContextPressure API**: Soft/hard limits with nudges
- **Recovery extraction**: Trailing stop on agent kill
- **Kill/ nudge decision matrix**: Pressure-driven lifecycle

### 15. **Tool Guards** (learn/agents.mdx)
- **Declarative rejection rules**: Prevent disallowed tool use
- **Research-before-delegation**: Tool history checks at delegation boundary

## Summary

**Explicitly documented abstractions**:
- **Agents**: `agent`, `agentPool`, `useAgent`, `useAgentPool`
- **Patterns**: ReAct, Reflection, RIG (Retrieval-Interleaved Generation)
- **Tools**: `Tool<TArgs>`, `EntailmentScorer`, custom tool patterns
- **Skills**: Skill catalog convention for tool amortization
- **Pipelines**: Custom DAG orchestration with RIG pattern
- **Infrastructure**: Branch lifecycle, Agent policy, KV pressure, Prefix sharing, Continuous context spine

**Key files documenting these**: examples/react-agent.md, examples/reflection.md, reference/skill-catalog.mdx, guides/custom-tool.md, reference/rig/overview.mdx, reference/agent-policy.mdx, reference/kv-pressure.mdx, learn/agents.mdx
