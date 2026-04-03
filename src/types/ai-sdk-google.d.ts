declare module "@ai-sdk/google" {
  import type { LanguageModel } from "ai";

  export function createGoogleGenerativeAI(config?: {
    apiKey?: string;
    baseURL?: string;
  }): (model: string) => LanguageModel;
}
