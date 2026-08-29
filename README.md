# Clinic OS

Clinic OS turns clinic artifacts into traceable workflows and manager closure views.

This repository currently contains only the WO-001 in-memory domain tracer:

```text
employee report -> Artifact -> EvidenceFactCard -> Workflow -> Expectation -> manager view
```

Requirements: Node.js 24 or newer. No package installation is required.

```bash
npm test
npm run demo
```

The implementation uses synthetic data only. It is not a production application.
