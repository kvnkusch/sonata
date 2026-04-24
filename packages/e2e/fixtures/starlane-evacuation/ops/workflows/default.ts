import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  defineStep,
  defineWorkflow,
  stepResult,
} from "__SONATA_WORKFLOW_IMPORT__";

const sectors = ["aurora", "cinder", "glass"] as const;

type SectorName = (typeof sectors)[number];

type SurveyInvocation = {
  sector: SectorName;
};

type SectorReport = {
  sector: SectorName;
  route: string;
  evacCapacity: number;
  ready: boolean;
  riskLevel: string;
};

const routes: Record<SectorName, string> = {
  aurora: "Lighthouse Corridor",
  cinder: "Magnetar Slipway",
  glass: "Helios Causeway",
};

function parseSurveyInvocation(input: unknown): SurveyInvocation {
  if (!input || typeof input !== "object") {
    throw new Error("survey_sector invocation is required");
  }

  const sector = (input as { sector?: unknown }).sector;
  if (typeof sector !== "string" || !sectors.includes(sector as SectorName)) {
    throw new Error(`Invalid survey sector: ${String(sector)}`);
  }

  return { sector: sector as SectorName };
}

function parseSectorReport(input: unknown): SectorReport {
  if (!input || typeof input !== "object") {
    throw new Error("sector_report payload must be an object");
  }

  const report = input as {
    sector?: unknown;
    route?: unknown;
    evacCapacity?: unknown;
    ready?: unknown;
    riskLevel?: unknown;
  };

  if (
    typeof report.sector !== "string" ||
    !sectors.includes(report.sector as SectorName)
  ) {
    throw new Error(`Invalid report sector: ${String(report.sector)}`);
  }
  if (typeof report.route !== "string" || report.route.trim().length === 0) {
    throw new Error("sector_report.route must be a non-empty string");
  }
  if (
    !Number.isInteger(report.evacCapacity) ||
    Number(report.evacCapacity) <= 0
  ) {
    throw new Error("sector_report.evacCapacity must be a positive integer");
  }
  if (typeof report.ready !== "boolean") {
    throw new Error("sector_report.ready must be a boolean");
  }
  if (
    typeof report.riskLevel !== "string" ||
    report.riskLevel.trim().length === 0
  ) {
    throw new Error("sector_report.riskLevel must be a non-empty string");
  }

  return {
    sector: report.sector as SectorName,
    route: report.route,
    evacCapacity: Number(report.evacCapacity),
    ready: report.ready,
    riskLevel: report.riskLevel,
  };
}

const missionControl = defineStep({
  id: "mission_control",
  title: "Mission Control",
  artifacts: [
    { name: "evacuation_plan", kind: "markdown", required: true, once: true },
  ] as const,
});

const surveySector = defineStep({
  id: "survey_sector",
  title: "Survey Sector",
  inputs: {
    invocation: {
      schema: {
        parse: parseSurveyInvocation,
      },
    },
  },
  artifacts: [
    {
      name: "sector_report",
      kind: "json",
      schema: {
        parse: parseSectorReport,
      },
      required: true,
      once: true,
    },
  ] as const,
});

const workflow = defineWorkflow({
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Starlane Evacuation Board",
  description:
    "Dispatch survey squadrons, wait for their reports, then publish a guarded convoy plan.",
  steps: [missionControl, surveySector] as const,
});

export default workflow.implement({
  mission_control: {
    async run(ctx) {
      const children = await ctx.children.list({ stepKey: "survey_sector" });
      if (children.length === 0) {
        for (const sector of sectors) {
          await ctx.children.spawn({
            stepKey: "survey_sector",
            workKey: sector,
            invocation: { sector },
          });
        }
        return;
      }

      const summary = await ctx.children.summary({
        stepKey: "survey_sector",
        workKeys: [...sectors],
      });
      if (summary.totalCount !== sectors.length) {
        throw new Error(
          `Expected ${sectors.length} survey squadrons, found ${summary.totalCount}`,
        );
      }
      if (summary.completedCount !== sectors.length) {
        return;
      }

      const artifactRefs = await ctx.children.readArtifacts({
        stepKey: "survey_sector",
        artifactName: "sector_report",
        workKeys: [...sectors],
      });
      if (artifactRefs.length !== sectors.length) {
        throw new Error(
          `Expected ${sectors.length} sector reports, found ${artifactRefs.length}`,
        );
      }

      const reports = artifactRefs
        .map((ref) => {
          const absolutePath = path.join(ctx.opsRoot, ref.relativePath);
          return JSON.parse(readFileSync(absolutePath, "utf8")) as SectorReport;
        })
        .sort((left, right) => left.sector.localeCompare(right.sector));

      const totalCapacity = reports.reduce(
        (sum, report) => sum + report.evacCapacity,
        0,
      );
      const markdown = [
        "# Starlane Evacuation Plan",
        "",
        "Mission control has received all sector reports for convoy Nightglass.",
        "",
        `Total evacuation capacity: ${totalCapacity}`,
        "",
        ...reports.map(
          (report) =>
            `- ${report.sector[0]!.toUpperCase()}${report.sector.slice(1)}: ${report.route} (${report.evacCapacity} evacuees, risk ${report.riskLevel})`,
        ),
        "",
        "Launch remains blocked until repoRoot/captain-approval.md is present.",
      ].join("\n");

      await ctx.writeMarkdownArtifact({ slug: "evacuation_plan", markdown });

      return stepResult.completed({
        completionPayload: {
          convoy: "Nightglass",
          readySectors: reports.length,
          totalCapacity,
        },
      });
    },
    async on() {},
    waitFor() {
      return {
        kind: "children",
        childStepKey: "survey_sector",
        workKeys: [...sectors],
        until: "all_completed",
        label: "Waiting for survey squadrons",
        details: { convoy: "Nightglass" },
      };
    },
    canComplete(ctx) {
      const approvalPath = path.join(ctx.repoRoot, "captain-approval.md");
      if (!existsSync(approvalPath)) {
        return {
          ok: false,
          code: "captain_approval_missing",
          message:
            "Mission control requires a signed captain approval before departure.",
          details: { approvalPath: "captain-approval.md" },
        };
      }
      return { ok: true };
    },
  },
  survey_sector: {
    async run(ctx) {
      const sector = ctx.inputs.invocation.sector;
      const report = {
        sector,
        route: routes[sector],
        evacCapacity:
          sector === "aurora" ? 180 : sector === "cinder" ? 120 : 150,
        ready: true,
        riskLevel:
          sector === "aurora" ? "low" : sector === "cinder" ? "medium" : "low",
      };

      await ctx.writeJsonArtifact({ slug: "sector_report", data: report });
      return stepResult.completed({
        completionPayload: { sector, route: report.route },
      });
    },
    async on() {},
  },
});
