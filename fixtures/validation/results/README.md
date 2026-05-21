# Sherpa Validation Results

This directory is the home for generated and reviewed research reports.

Do not edit raw generated JSON after a run except to remove host-specific paths or sensitive data before publication. If a result needs interpretation, add a separate Markdown report that cites the generated artifact path and command.

## Expected Artifacts

For each run, keep:

- validation command
- git SHA
- dataset split
- ontology version
- projection prompt version
- state strategy or baseline name
- raw or publication-sanitized JSON output
- summarized Markdown report
- accepted/rejected claim decisions

## Naming

Use stable names:

- `YYYY-MM-DD-offline-dev.json`
- `YYYY-MM-DD-offline-dev.md`
- `YYYY-MM-DD-sandbox-advisory.json`
- `YYYY-MM-DD-sandbox-advisory.md`

## Evidence Rules

- Train/dev results can guide iteration.
- Test results should be generated only for final reporting checkpoints.
- Do not compare test runs from different projection or ontology versions without documenting the version change.
- Negative results are first-class results.
