import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { runKeys } from "../../src/features/runs/_services/run-keys";
import { useRunDetail, useRuns, useSpanDetail } from "../../src/features/runs/_services/run-queries";
import { useConversation, useReplayOptions, useRunChat } from "../../src/features/runs/_services/view-queries";
import { api } from "../../src/lib/api";
import { useLiveEvents } from "../../src/lib/live-events";

// Infinite stale time makes SSE responsible for updates; automatic refetches cannot hide a regression.
const makeClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });

function Listener() {
  const { connected, spanTick } = useLiveEvents();
  return <><output data-testid="connected">{String(connected)}</output><output data-testid="span-tick">{spanTick}</output></>;
}

function Views() {
  const list = useRuns({ q: "", status: "", hasFinding: false, project: "" });
  const a = useRunDetail("a");
  const b = useRunDetail("b");
  const chat = useRunChat("a");
  const conversation = useConversation("a", true);
  const replay = useReplayOptions("a", true);
  const span = useSpanDetail("a", "span");
  const evidence = useQuery({ queryKey: [...runKeys.detail("a"), "review", "frozen"], queryFn: () => api("/api/evidence") });
  return <>{Object.entries({ list, a, b, chat, conversation, replay, span, evidence }).map(([name, query]) =>
    <pre key={name} data-testid={name}>{JSON.stringify(query.data) ?? "loading"}</pre>,
  )}</>;
}

function Harness() {
  const [client, setClient] = useState(makeClient);
  const [revision, setRevision] = useState(0);
  const [listening, setListening] = useState(true);
  useEffect(() => {
    void client.prefetchQuery({ queryKey: runKeys.detail("inactive"), queryFn: () => api("/api/runs/inactive") });
    return () => client.clear();
  }, [client]);
  return <QueryClientProvider client={client}>
    <button id="stop" onClick={() => setListening(false)}>Stop listening</button>
    <button id="start" onClick={() => setListening(true)}>Start listening</button>
    <button id="replace" onClick={() => { setClient(makeClient()); setRevision((value) => value + 1); }}>Replace query client</button>
    {listening && <Listener />}<Views key={revision} />
  </QueryClientProvider>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
