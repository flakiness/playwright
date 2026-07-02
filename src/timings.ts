import { FlakinessReport } from "@flakiness/flakiness-report";
import { ReportUtils } from "@flakiness/sdk";
import { FullProject } from "@playwright/test";
import { TestCase } from "@playwright/test/reporter";
import { computeFKTestId } from "./reportBuilder.js";

export function distillTimings(reports: FlakinessReport.Report[]): FlakinessReport.Report {
  // We will be mutating reports - protect them.
  // While this is NOT strictly necessary, it'll make for a clean API.
  reports = reports.map(r => structuredClone(r));

  const acc: FlakinessReport.Report = {
    category: reports[0].category,
    commitId: reports[0].commitId,
    flakinessProject: reports[0].flakinessProject,
    configPath: reports[0].configPath,
    duration: 0 as FlakinessReport.DurationMS,
    environments: [],
    startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
    suites: [],
    tests: [],
  };

  for (const report of reports) {
    // Mutate tests, dropping all the excess information.
    ReportUtils.visitTests(report, (test, parents) => {
      // Locations are NOT used in suites or tests to match tests.
      parents.forEach(suite => { delete suite.location; })
      delete test.location;
      // Tags are not used as well.
      delete test.tags;

      // Accumulate all attempts per env
      const envDurations = new Map<number, FlakinessReport.DurationMS>();
      for (const attempt of test.attempts) {
        if (attempt.duration === undefined)
          continue;
        const envIdx = (attempt.environmentIdx ?? 0) + acc.environments.length;
        const sum = envDurations.get(envIdx) ?? 0;
        envDurations.set(envIdx, sum + attempt.duration as FlakinessReport.DurationMS);
      }
      test.attempts = Array.from(envDurations, ([environmentIdx, duration]) => ({
        environmentIdx,
        duration,
      }));
    });
    // In environments, we only keep the name: the later matching mechanic only relies on
    // environment names.
    acc.environments = [acc.environments, report.environments.map(env => ({
      name: env.name,
    }))].flat();
    acc.tests = [acc.tests ?? [], report.tests ?? []].flat();
    acc.suites = [acc.suites ?? [], report.suites ?? []].flat();
  }
  const timings = ReportUtils.normalizeReport(acc);
  ReportUtils.visitTests(timings, test => {
    // Across different reports, attempts for the same environment will be merged using the max duration.
    // Accumulate all attempts per env
    const envDurations = new Map<number, FlakinessReport.DurationMS>();
    for (const attempt of test.attempts) {
      if (attempt.duration === undefined)
        continue;
      const acc = envDurations.get(attempt.environmentIdx ?? 0) ?? -Infinity;
      envDurations.set(attempt.environmentIdx ?? 0, Math.max(acc, attempt.duration) as FlakinessReport.DurationMS);
    }
    test.attempts = Array.from(envDurations, ([environmentIdx, duration]) => ({
      environmentIdx,
      duration,
    }));

    // Finally, if there are repetitive durations, then we can drop them:
    // the algorithm will pick a maximum from attempts if there's no environment matching
    // name.
    const differentDurations = new Set(test.attempts.map(a => a.duration));
    if (differentDurations.size === 1)
      test.attempts = [test.attempts[0]];
  });
  return ReportUtils.normalizeReport(timings);
}

export function computeDurationPredictions(timings: FlakinessReport.Report, projectToEnvNames: Map<FullProject, string>, testMappings: Map<string, TestCase[]>) {
  const durationPredictions = new Map<TestCase, number>();
  ReportUtils.visitTests(timings, (test, parentSuites) => {
    // Accumulate test durations per environment: we consider test duration to be a cumulative
    // of all attempts per environment. For example, if it reliably passes only on the second try, then
    // its duration is the sum of the both attempts.
    const durationsPerEnv = new Map<string, number>();
    for (const attempt of test.attempts) {
      const envName = timings.environments[attempt.environmentIdx ?? 0]?.name;
      // Defensive programming: this should never happen.
      if (!envName)
        continue;
      const acc = durationsPerEnv.get(envName) ?? 0;
      durationsPerEnv.set(envName, acc + (attempt.duration ?? 0));
    }
    // No data for the test? Skip it and rely on DEFAULT_DURATION.
    if (!durationsPerEnv.size)
      return;
    const maxDuration = Math.max(...Array.from(durationsPerEnv.values()));

    const fkTestId = computeFKTestId(test, parentSuites);
    const testCases = testMappings.get(fkTestId) ?? [];
    for (const testCase of testCases) {
      // For each test case, find an envName it is mapped to.
      const project = testCase.parent.project();
      const envName = project ? projectToEnvNames.get(project) : undefined;
      // For each test case, we want to find the best timing approximation.
      // We either try to find the environment with the same name (these should be unique),
      // and otherwise use a max duration.
      const envDuration = envName ? durationsPerEnv.get(envName) : undefined;
      // We fallback to the max of the test durations across environments.
      durationPredictions.set(testCase, envDuration ?? maxDuration);
    }
  });
  return durationPredictions;
}
