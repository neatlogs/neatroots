# Finding-review references

Consulted 2026-10-17. Product patterns only; implementation uses the existing
shared Neatlogs primitives and does not import competitor code or styling.

1. [Existing neatroots Runs](../../packages/ui/src/features/runs/_components/runs-page.tsx):
   page chrome, sticky filters, compact table and semantic tokens are authoritative.
2. [Existing Problems panel](../../packages/ui/src/features/runs/_components/problems-panel.tsx):
   finding status, explanation and evidence vocabulary remain consistent.
3. [Langfuse annotation queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues):
   evidence, explicit feedback and complete/next workflow. No team assignment or rubrics.
4. [LangSmith annotation queues](https://docs.langchain.com/langsmith/annotation-queues):
   one item at a time and progress. This implementation remains local and finding-specific.
5. [tweakcn](https://tweakcn.com): reviewed theme tooling; retain existing semantic
   tokens instead of introducing another theme. [Uncut](https://uncut.wtf) was also
   consulted; existing readable app typography takes precedence over a new font.
6. [Minimal Gallery](https://minimal.gallery): restrained hierarchy and whitespace.
   Existing dashboard density takes precedence over landing-page layouts.

Also consulted Number Flow; plain tabular counts suit this task. Design for B2B and
DialKit did not return readable content during lookup. No new dependency is needed.
