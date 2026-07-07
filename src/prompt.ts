export function serializePromptData(data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? "null";
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
