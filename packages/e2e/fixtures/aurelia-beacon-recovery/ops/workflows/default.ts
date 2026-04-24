import { defineStep, defineWorkflow } from "__SONATA_WORKFLOW_IMPORT__";

const stabilizeBeacon = defineStep({
  id: "stabilize_beacon",
  title: "Stabilize Beacon",
  opencode: {},
  artifacts: [
    {
      name: "repair_manifest",
      kind: "markdown",
      required: true,
      once: true,
    },
  ] as const,
});

const workflow = defineWorkflow({
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Aurelia Beacon Recovery",
  description:
    "Use an OpenCode session to restore the beacon, including blocked and orphaned recovery paths.",
  steps: [stabilizeBeacon] as const,
});

export default workflow.implement({
  stabilize_beacon: {
    async run(ctx) {
      await ctx.opencode.start({
        title: "Aurelia Beacon Recovery",
        prompt:
          "Inspect the relay status, wait if the beacon needs a live operator, and complete once the repair manifest is written.",
      });
    },
    async on() {},
  },
});
