// Secret/credential detection layer. Wraps `@secretlint/core` â€” an
// offline, in-process linter â€” behind a small async surface that returns
// {@link SensitiveMatch}es for a single string. The engine and rule creators are
// imported dynamically so secretlint (and its large rule set) is only loaded the
// first time a scan actually runs, not at app startup.

import type {
  SecretLintCoreConfig,
  SecretLintCoreResult,
} from "@secretlint/types";

import type { SensitiveMatch } from "../../common/sensitive";
import {
  buildSecretlintConfig,
  mapSecretlintMessage,
} from "./secretlint-config";

type LintSource = (args: {
  source: {
    content: string;
    filePath: string;
    ext?: string;
    contentType: "text";
  };
  options: { config: SecretLintCoreConfig; maskSecrets?: boolean };
}) => Promise<SecretLintCoreResult>;

interface Engine {
  lintSource: LintSource;
  config: SecretLintCoreConfig;
}

async function loadEngine(): Promise<Engine> {
  const [core, preset, pattern] = await Promise.all([
    import("@secretlint/core"),
    import("@secretlint/secretlint-rule-preset-recommend"),
    import("@secretlint/secretlint-rule-pattern"),
  ]);
  return {
    lintSource: core.lintSource as LintSource,
    config: buildSecretlintConfig(preset.creator, pattern.creator),
  };
}

/** A scanner failure must block evidence preparation. Never log input or engine errors. */
export function createSecretScanner(load: () => Promise<Engine> = loadEngine) {
  let enginePromise: Promise<Engine> | null = null;
  return async (text: string): Promise<SensitiveMatch[]> => {
    if (!text.trim()) return [];
    try {
      enginePromise ??= load();
      const engine = await enginePromise;
      const result = await engine.lintSource({
        source: {
          content: text,
          filePath: "evidence.txt",
          ext: ".txt",
          contentType: "text",
        },
        options: { config: engine.config, maskSecrets: true },
      });
      if (!Array.isArray(result.messages))
        throw new Error("Invalid scanner result");
      return result.messages
        .map((message) => mapSecretlintMessage(message, text))
        .filter((match): match is SensitiveMatch => match !== null);
    } catch {
      enginePromise = null;
      throw new Error(
        "Privacy scanning is unavailable. Retry before preparing evidence for AI.",
      );
    }
  };
}
export const scanSecrets = createSecretScanner();
