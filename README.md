# Clinic OS

Clinic OS turns clinic artifacts into traceable workflows and manager closure views.

This repository contains the WO-001 in-memory domain tracer and the WO-002 local preview shell:

```text
employee report -> Artifact -> EvidenceFactCard -> Workflow -> Expectation -> manager view
```

Requirements: Node.js 24 or newer. No package installation is required.

```bash
npm test
npm run demo
npm run preview
```

Open `http://127.0.0.1:3000/employee` for the employee preview or
`http://127.0.0.1:3000/manager` for the manager preview. The implementation
uses in-memory synthetic data only and is not a production application.
