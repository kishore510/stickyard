/*
 * The two models AI features use (v0.42.0). One small and one large; no picker in the UI.
 * Checked against Anthropic's models and deprecations pages on 15 October 2026. Claude Haiku 4.5
 * (Chalkline's small model) is due to retire from 15 October 2026, so it isn't used.
 * When a date below comes near, move to the recommended replacement in the same kind of change.
 */

export interface AiModel {
  /** The API model id. */
  id: string;
  /** What the page calls it. */
  name: string;
}

/** Fast and low cost: $0.10 / $0.50 per million input / output tokens (prompts up to 100K tokens). */
export const SMALL_MODEL: AiModel = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  // Retirement: not sooner than 7 October 2027 (Anthropic's model deprecations page).
};

/** More capable: $2 / $10 per million input / output tokens. */
export const LARGE_MODEL: AiModel = {
  id: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  // Retirement: not sooner than 28 September 2027 (Anthropic's model deprecations page).
};

export const AI_MODELS: readonly AiModel[] = [SMALL_MODEL, LARGE_MODEL];
