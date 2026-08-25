import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgeAgents } from "./agents/register.ts";
import { registerForgeCommands } from "./ui/commands.ts";
import { ForgeOrchestrationController } from "./workflows/orchestrate.ts";
import { ForgeWorkOnController } from "./workflows/work-on.ts";

export default function forgedockPiExtension(pi: ExtensionAPI): void {
  const agentRegistrations = registerForgeAgents(pi);
  const controller = new ForgeWorkOnController(pi);
  const orchestrator = new ForgeOrchestrationController(pi, controller);
  registerForgeCommands(pi, controller, orchestrator);

  pi.on("session_start", async (_event, ctx) => {
    await orchestrator.attach(ctx);
    await controller.attach(ctx);
    await orchestrator.resume(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload")
      await orchestrator.shutdown(
        ctx,
        `Owning Pi session ended (${event.reason}); release the repository lease.`,
      );
    orchestrator.dispose();
    controller.dispose();
    for (const registration of agentRegistrations) registration.dispose();
  });
}
