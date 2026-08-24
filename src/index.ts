import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgeAgents } from "./agents/register.ts";
import { registerForgeCommands } from "./ui/commands.ts";
import { ForgeWorkOnController } from "./workflows/work-on.ts";

export default function forgedockPiExtension(pi: ExtensionAPI): void {
  const agentRegistrations = registerForgeAgents(pi);
  const controller = new ForgeWorkOnController(pi);
  registerForgeCommands(pi, controller);

  pi.on("session_start", async (_event, ctx) => {
    await controller.attach(ctx);
  });

  pi.on("session_shutdown", () => {
    controller.dispose();
    for (const registration of agentRegistrations) registration.dispose();
  });
}
