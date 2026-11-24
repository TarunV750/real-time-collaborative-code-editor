import * as Y from "yjs";
export const STARTER = `/**\n * Welcome to your shared workspace.\n * Invite a teammate and build something together.\n */\n\ntype Collaborator = {\n  name: string;\n  role: 'driver' | 'navigator';\n};\n\nconst team: Collaborator[] = [\n  { name: 'You', role: 'driver' },\n  { name: 'Your teammate', role: 'navigator' },\n];\n\nfunction greetTeam(members: Collaborator[]) {\n  return members.map(({ name }) => {\n    return \`Hello, \${name}! Let's build.\`;\n  });\n}\n\nconsole.log(greetTeam(team));\n`;
export function mergeState(stored: Uint8Array, incoming: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored);
  Y.applyUpdate(doc, incoming);
  const result = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return result;
}
