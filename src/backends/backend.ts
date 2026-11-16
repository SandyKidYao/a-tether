import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Code } from "../shared/protocol.ts";

// route is a backend-local model identifier. Only the public model crosses the wire.
export type BackendModel = Model<string> & { route: string };
export interface Backend {
  name: string;
  // detail is a short local diagnostic for the C log; it never crosses the wire.
  status(signal?: AbortSignal): Promise<{ available: boolean; loggedIn: boolean; diagnostic: boolean; detail?: string }>;
  models(signal: AbortSignal): Promise<BackendModel[]>;
  stream(model: BackendModel, context: TranscriptContext, options: SimpleStreamOptions): AssistantMessageEventStream;
  errorCode(detail: string): Code;
}
