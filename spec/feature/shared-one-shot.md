# Shared one-shot launch

Brain/LLM Backends uses the pinned Lapilli submodule at `lib/lapilli` and its
`@ludiars/one-shot` local file dependency. Lapilli owns executable resolution,
subscription environment isolation and model role resolution. Pagus owns
prompts, response parsing, deadlines, output-file cleanup and existing retries.
The simulation remains independent of CLI transports.

Claude defaults resolve the central opus/sonnet/haiku roles. The explicitly
specified GPT-5.6 cast and its assignment weights remain Pagus policy.
Codex retains its read-only sandbox. No live inference or service restart is
part of implementation validation. Revisor initializes the submodule before
dependency installation. Rollback restores the consumer and gitlink together.
