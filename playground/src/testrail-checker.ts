import axios, { AxiosInstance } from "axios";
import { LinearClient } from "@linear/sdk";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// --- Types ---

interface TestRailStatus {
  id: number;
  name: string;
  label: string;
  is_system: boolean;
}

interface TestRailTest {
  id: number;
  case_id: number;
  title: string;
  status_id: number;
  custom_issue_field?: string;
  [key: string]: unknown;
}

interface CategorizedResult {
  caseId: number;
  title: string;
  linearId: string | null;
  linearStatus: string | null;
  category: "needs_checking" | "known" | "no_link";
  order: number;
}

// --- TestRail API ---

function createTestRailClient(baseUrl: string, email: string, apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: `${baseUrl.replace(/\/+$/, "")}/index.php?/api/v2`,
    auth: { username: email, password: apiKey },
    headers: { "Content-Type": "application/json" },
  });
}

async function getAutoTestFailedStatusId(client: AxiosInstance): Promise<number> {
  const { data: statuses } = await client.get<TestRailStatus[]>("/get_statuses");
  const match = statuses.find(
    (s) => s.label.toLowerCase() === "autotest failed" || s.name.toLowerCase() === "autotest_failed"
  );
  if (!match) {
    console.error("Available statuses:", statuses.map((s) => `${s.id}: ${s.label} (${s.name})`).join(", "));
    throw new Error('Could not find "AutoTest Failed" status in TestRail. See available statuses above.');
  }
  return match.id;
}

async function getFailedTests(client: AxiosInstance, runId: string, statusId: number): Promise<TestRailTest[]> {
  const allTests: TestRailTest[] = [];
  let offset = 0;
  const limit = 250;

  while (true) {
    const { data } = await client.get<{ tests: TestRailTest[]; _links: { next: string | null } } | TestRailTest[]>(
      `/get_tests/${runId}&status_id=${statusId}&limit=${limit}&offset=${offset}`
    );

    // TestRail API v2 may return paginated or flat response
    const tests = Array.isArray(data) ? data : data.tests;
    allTests.push(...tests);

    if (Array.isArray(data) || !data._links?.next || tests.length < limit) break;
    offset += limit;
  }

  return allTests;
}

// --- Linear API ---

function extractLinearId(test: TestRailTest): string | null {
  const fieldValue = test.custom_issue_field;
  if (!fieldValue || typeof fieldValue !== "string") {
    // Log available custom fields for debugging on first miss
    const customFields = Object.keys(test).filter((k) => k.startsWith("custom_"));
    if (customFields.length > 0) {
      console.warn(`  [debug] No value in custom_issue_field for C${test.case_id}. Available custom fields: ${customFields.join(", ")}`);
    }
    return null;
  }

  // Match patterns like SPX-123, QC-45, etc. (from URL or plain text)
  const match = fieldValue.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

async function checkLinearStatus(
  linearClient: LinearClient,
  issueId: string
): Promise<{ status: string; statusType: string } | null> {
  try {
    const issue = await linearClient.issue(issueId);
    const state = await issue.state;
    if (!state) return null;
    return { status: state.name, statusType: state.type };
  } catch {
    console.warn(`  [warn] Could not find Linear issue ${issueId}`);
    return null;
  }
}

function categorize(statusType: string | null): "needs_checking" | "known" | "no_link" {
  if (!statusType) return "no_link";
  // "completed" type in Linear includes Done, Merged, Passed testing, etc.
  return statusType === "completed" ? "needs_checking" : "known";
}

// --- URL Parsing ---

function parseRunUrl(url: string): { baseUrl: string; runId: string } {
  // Matches: https://instance.testrail.io/index.php?/runs/view/123
  // Also: https://instance.testrail.io/index.php?/runs/view/123&...
  const match = url.match(/^(https?:\/\/[^/]+)\/.*\/runs\/view\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid TestRail run URL: ${url}\nExpected format: https://<instance>.testrail.io/index.php?/runs/view/<run_id>`);
  }
  return { baseUrl: match[1], runId: match[2] };
}

// --- Main ---

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx ts-node src/testrail-checker.ts <testrail-run-url>");
    process.exit(1);
  }

  const email = process.env.TESTRAIL_EMAIL;
  const apiKey = process.env.TESTRAIL_API_KEY;
  const linearApiKey = process.env.LINEAR_API_KEY;

  if (!email || !apiKey) {
    console.error("Missing TESTRAIL_EMAIL or TESTRAIL_API_KEY in .env");
    process.exit(1);
  }
  if (!linearApiKey) {
    console.error("Missing LINEAR_API_KEY in .env");
    process.exit(1);
  }

  const { baseUrl, runId } = parseRunUrl(url);
  const trClient = createTestRailClient(baseUrl, email, apiKey);
  const linearClient = new LinearClient({ apiKey: linearApiKey });

  console.log(`Fetching statuses from TestRail...`);
  const statusId = await getAutoTestFailedStatusId(trClient);

  console.log(`Fetching failed tests from run #${runId} (status_id=${statusId})...`);
  const failedTests = await getFailedTests(trClient, runId, statusId);

  if (failedTests.length === 0) {
    console.log(`\nNo "AutoTest Failed" cases found in run #${runId}.`);
    return;
  }

  console.log(`Found ${failedTests.length} failed test(s). Checking Linear statuses...\n`);

  // Process in order, preserving TestRail sequence
  const results: CategorizedResult[] = [];
  for (let i = 0; i < failedTests.length; i++) {
    const test = failedTests[i];
    const linearId = extractLinearId(test);

    let linearStatus: string | null = null;
    let category: CategorizedResult["category"] = "no_link";

    if (linearId) {
      const status = await checkLinearStatus(linearClient, linearId);
      if (status) {
        linearStatus = status.status;
        category = categorize(status.statusType);
      } else {
        // Linear issue ID found but couldn't resolve — treat as no link
        category = "no_link";
      }
    }

    results.push({
      caseId: test.case_id,
      title: test.title,
      linearId,
      linearStatus,
      category,
      order: i,
    });
  }

  // Group by category while preserving order within each group
  const needsChecking = results.filter((r) => r.category === "needs_checking").sort((a, b) => a.order - b.order);
  const known = results.filter((r) => r.category === "known").sort((a, b) => a.order - b.order);
  const noLink = results.filter((r) => r.category === "no_link").sort((a, b) => a.order - b.order);

  // Print report
  console.log(`TestRail Run #${runId} — Failed Cases Report`);
  console.log("=".repeat(50));

  if (needsChecking.length > 0) {
    console.log(`\nNEEDS CHECKING (fix released, still failing):`);
    for (const r of needsChecking) {
      console.log(`  - C${r.caseId}: ${r.title} — ${r.linearId} (${r.linearStatus})`);
    }
  }

  if (known.length > 0) {
    console.log(`\nKNOWN ISSUES (fix not yet released):`);
    for (const r of known) {
      console.log(`  - C${r.caseId}: ${r.title} — ${r.linearId} (${r.linearStatus})`);
    }
  }

  if (noLink.length > 0) {
    console.log(`\nNO LINEAR LINK:`);
    for (const r of noLink) {
      const suffix = r.linearId ? ` — ${r.linearId} (not found in Linear)` : "";
      console.log(`  - C${r.caseId}: ${r.title}${suffix}`);
    }
  }

  console.log(`\nSummary: ${needsChecking.length} need checking, ${known.length} known, ${noLink.length} unlinked`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
