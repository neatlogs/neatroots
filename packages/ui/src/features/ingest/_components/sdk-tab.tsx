import { CodeLine } from "@/components/code-line";
import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Every way the Neatlogs platform takes traces, pointed at this machine. Snippets follow the
// public Neatlogs docs (docs.neatlogs.com/sdk) with the endpoint swapped for neatroots.

const FRAMEWORKS = {
  "Providers": ["OpenAI", "Anthropic", "Google Gemini", "Azure OpenAI", "AWS Bedrock", "Vertex AI", "OpenRouter", "Ollama"],
  "Agent frameworks": ["LangChain", "LangGraph", "CrewAI", "OpenAI Agents SDK", "Pydantic AI", "DSPy", "Agno", "Strands", "Google ADK", "LlamaIndex", "Mastra", "Vercel AI SDK", "Claude Agent SDK"],
  "Through OpenTelemetry": ["OpenInference instrumentors", "OpenLLMetry (Traceloop)", "OpenTelemetry GenAI conventions", "Logfire", "any OTLP exporter"],
};

function Section({ title, badge, description, children }: { title: string; badge?: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card className="shadow-none transition-colors duration-300 hover:border-border-strong">
      <CardHeader className="gap-1 pb-4">
        <CardTitle className="flex items-center gap-2 font-pixel text-2xs tracking-caps-wide text-muted-foreground uppercase">
          <span>{title}</span>
          {badge && (
            <NeatBadge size="sm" variant="green">
              {badge}
            </NeatBadge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

export function SdkTab({ port, grpcPort, examples }: { port: number; grpcPort?: number; examples?: string | null }) {
  const base = `http://localhost:${port}`;
  const [lang, setLang] = useState<"python" | "typescript" | "go">("python");
  return (
    <div className="flex flex-col gap-4">
      <Section title="Neatlogs SDK" badge="recommended" description="Auto-instruments your LLM clients and agent frameworks. Point it at neatroots with two environment variables; in production, unset the endpoint and it goes to Neatlogs Cloud.">
        <SegmentedTabs
          size="compact"
          value={lang}
          onValueChange={setLang}
          items={[
            { value: "python", label: "Python" },
            { value: "typescript", label: "TypeScript" },
            { value: "go", label: "Go" },
          ]}
        />
        <CodeLine text={`export NEATLOGS_ENDPOINT=${base}\nexport NEATLOGS_API_KEY=neatroots-local   # any value works locally`} />
        {lang === "python" ? (
          <CodeLine text={`pip install -U neatlogs\n\nimport neatlogs\nneatlogs.init(workflow_name="my-agent", flush_interval=0.5)`} />
        ) : lang === "typescript" ? (
          <CodeLine text={`npm install neatlogs\n\nimport { init } from "neatlogs";\nawait init({ endpoint: process.env.NEATLOGS_ENDPOINT, workflowName: "my-agent", flushInterval: 0.5 });`} />
        ) : (
          <CodeLine text={`go get github.com/neatlogs/neatlogs-go\n\nshutdown, err := neatlogs.Init(ctx, neatlogs.Config{Endpoint: "${base}", WorkflowName: "my-agent"})\ndefer shutdown(ctx)`} />
        )}
        <p className="text-xs text-muted-foreground">Not set up yet? <span className="font-mono">npx @neatlogs/wizard</span> detects your stack and adds the SDK.</p>
      </Section>
      <Section title="Browser SDK" description="Traces from front-end code over fetch. Use any key locally; in production use a write key (nlw_…).">
        <CodeLine text={`import { Neatlogs } from "neatlogs/browser";\n\nconst nl = new Neatlogs({ apiKey: "neatroots-local", project: "my-web-app", endpoint: "${base}" });`} />
      </Section>
      <Section title="HTTP trace API" description="No SDK: POST one JSON tree per trace. Nesting in children sets the hierarchy; neatroots makes the ids.">
        <CodeLine
          text={`curl -X POST ${base}/v1/trace -H 'content-type: application/json' -d '{\n  "name": "support-chat", "project": "my-agent", "input": "Where is my order?",\n  "children": [\n    {"name": "lookup", "tool_name": "lookup_order", "input": {"id": 1001}, "output": {"status": "shipped"}},\n    {"name": "answer", "model": "gpt-4o", "input": "Where is my order?", "output": "It shipped.", "tokens": {"prompt": 20, "completion": 4}}\n  ]\n}'`}
        />
      </Section>
      <Section title="OpenTelemetry (OTLP)" description="Any OpenTelemetry exporter, with OpenInference, OpenLLMetry or GenAI attributes. HTTP (protobuf or JSON) on the app port, gRPC on its own.">
        <CodeLine text={`# OTLP/HTTP\nexport OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces\nexport OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`} />
        <CodeLine text={grpcPort ? `# OTLP/gRPC\nexport OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:${grpcPort}\nexport OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc` : "# OTLP/gRPC is off; start neatroots with --grpc-port 4317"} />
        <CodeLine text={`export OTEL_SERVICE_NAME=my-agent   # becomes the project in neatroots`} />
      </Section>
      <Section title="Runnable examples" description="No agent of your own yet? Fifteen examples across SDKs, frameworks and ingestion paths, all without API keys: they talk to neatroots' mock LLM.">
        <CodeLine
          text={`neatroots mock-llm &                      # a stand-in LLM (OpenAI and Anthropic APIs)\ncd ${examples ?? "examples"}/python-openai\nuv run agent.py "Please refund order 1001"\n\nsh ${examples ?? "examples"}/run-all.sh   # every example, checked`}
        />
      </Section>
      <Section title="What works" description="Everything the Neatlogs SDK instruments, plus anything that speaks OpenTelemetry.">
        {Object.entries(FRAMEWORKS).map(([group, items]) => (
          <div key={group} className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">{group}</span>
            <div className="flex flex-wrap gap-1.5">
              {items.map((f) => (
                <NeatBadge key={f} size="sm" variant="outline">
                  {f}
                </NeatBadge>
              ))}
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
