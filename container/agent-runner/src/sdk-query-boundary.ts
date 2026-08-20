export function invokeClaudeQuery<TPrompt, TOptions, TResult>(
  queryFn: (input: { prompt: TPrompt; options: TOptions }) => TResult,
  prompt: TPrompt,
  options: TOptions,
): TResult {
  return queryFn({ prompt, options });
}
