# AI Context Intelligence Module

Member 3 service for the **Digital Handoff & Continuity Management Platform**.

## 1. Purpose

The AI Context Intelligence module analyzes, extracts, and synthesizes context across developer shift handoffs, incidents, and ongoing operations. Powered by Groq, it processes prepared context packs from Relay's core backend, validates their structure against shared contracts, and produces structured context syntheses, decisions, blockers, proposed next tasks, and detected contradictions.

---

## 2. Setup Instructions

### Create and Activate a Python Virtual Environment

From the repository root (or inside the `aiml/` directory):

**Windows (PowerShell):**
```powershell
python -m venv aiml/.venv
.\aiml\.venv\Scripts\Activate.ps1
```

**Windows (Command Prompt):**
```cmd
python -m venv aiml\.venv
aiml\.venv\Scripts\activate.bat
```

**macOS / Linux:**
```bash
python3 -m venv aiml/.venv
source aiml/.venv/bin/activate
```

---

### Install Dependencies

With the virtual environment activated:

```bash
pip install -r aiml/requirements.txt
```

---

### Environment Variables

Configure your local environment by creating `aiml/.env`:

```bash
# Windows (PowerShell)
Copy-Item aiml/.env.example aiml/.env

# macOS / Linux / bash
cp aiml/.env.example aiml/.env
```

| Variable | Description | Default |
|---|---|---|
| `GROQ_API_KEY` | Your Groq Cloud API key (`gsk_...`) | *Required for generation* |
| `GROQ_MODEL` | Groq chat completion model | `openai/gpt-oss-20b` |
| `GROQ_TIMEOUT` | API request timeout in seconds | `30.0` |

> [!NOTE]
> Never commit `.env` or real API keys to version control. `aiml/.gitignore` automatically excludes `.env` files.

---

## 3. API Endpoints

### `GET /`
Returns a welcome greeting and confirmation that the service is running.

### `GET /health`
Returns service name and health status:
```json
{
  "service": "AI Context Intelligence",
  "status": "healthy"
}
```

### `POST /api/v1/context-packs/validate`
Validates an incoming prepared context pack (`ContextPackRequest`) against the AI module's input contracts without calling external LLMs:
```json
{
  "valid": true,
  "case_id": "proj_relay_alpha_101",
  "source_count": 2,
  "task_count": 1,
  "document_count": 1,
  "message": "Context pack validated successfully."
}
```

### `POST /api/v1/context-packs/generate`
Processes the context pack using Groq, extracting:
- Executive case summary and current posture
- Architectural and operational decisions (with cited `source_ids`)
- Previously attempted actions and outcomes
- Current blockers and severity levels
- Proposed next tasks (with deadlines only when supported by evidence; `null` if unstated)
- Identified information gaps and impacts
- Multi-source contradictions (requiring at least two distinct source references)

#### Example Request:
```json
{
  "case_id": "case_handoff_400",
  "case_description": "API Gateway Migration shift handoff",
  "sources": [
    {
      "id": "src_pr_12",
      "title": "Migrate auth routes to Gateway v2",
      "content": "Routes migrated. Verified in staging.",
      "provider": "github",
      "record_type": "pull_request"
    },
    {
      "id": "src_issue_88",
      "title": "CORS preflight failures on legacy endpoints",
      "content": "Users reporting CORS errors on /v1/auth.",
      "provider": "github",
      "record_type": "issue"
    }
  ],
  "tasks": [
    {
      "id": "task_50",
      "title": "Update CORS origin headers in gateway config",
      "status": "open",
      "priority": "high"
    }
  ],
  "documents": [
    {
      "id": "doc_spec_99",
      "title": "Gateway Security Baseline",
      "extracted_text": "CORS origins must only allow company domain. Migration deadline: 2026-10-15T00:00:00Z."
    }
  ]
}
```

#### Example Response:
```json
{
  "case_id": "case_handoff_400",
  "summary": "API Gateway migration is underway. Auth routes are migrated, but CORS errors persist on legacy endpoints.",
  "decisions": [
    {
      "decision": "Migrate auth routes to Gateway v2",
      "rationale": "Improved performance and unified routing",
      "source_ids": ["src_pr_12"],
      "decided_at": null
    }
  ],
  "attempted_actions": [
    {
      "action": "Deployed auth route migration in staging",
      "outcome": "Verified successfully in staging",
      "source_ids": ["src_pr_12"]
    }
  ],
  "blockers": [
    {
      "description": "CORS preflight failures blocking legacy endpoint access",
      "severity": "high",
      "source_ids": ["src_issue_88"]
    }
  ],
  "proposed_tasks": [
    {
      "title": "Deploy updated CORS origin configuration",
      "description": "Align origin headers with Gateway Security Baseline",
      "suggested_deadline": "2026-10-15T00:00:00Z",
      "priority": "high",
      "rationale": "Document specifies hard deadline for migration",
      "source_ids": ["doc_spec_99"]
    }
  ],
  "missing_information": [
    {
      "topic": "Legacy endpoint test coverage",
      "explanation": "No automated tests exist verifying preflight headers on legacy routes",
      "impact": "Potential downtime for mobile clients"
    }
  ],
  "contradictions": [
    {
      "title": "Route readiness contradiction",
      "description": "PR #12 states routes are verified, but Issue #88 notes users are encountering CORS failures",
      "severity": "medium",
      "sources": [
        {
          "source_id": "src_pr_12",
          "excerpt": "Routes migrated. Verified in staging.",
          "source_type": "pull_request",
          "url": null
        },
        {
          "source_id": "src_issue_88",
          "excerpt": "Users reporting CORS errors on /v1/auth.",
          "source_type": "issue",
          "url": null
        }
      ]
    }
  ]
}
```

---

## 4. Security & Evidence Traceability Guardrails

1. **Untrusted Data Isolation:** All user documents, issues, notes, and tasks are wrapped in `<untrusted_context_data>` boundaries. The system prompt instructs the model to disregard instructions embedded within source material.
2. **Evidence Citation Validation:** The service checks every cited `source_id` against the list of IDs present in the input. If the model invents or cites an unknown source, the response is rejected with `HTTP 422`.
3. **Contradiction Multi-Source Rule:** Each contradiction requires at least two distinct source references with verifying excerpts.
4. **No Invented Deadlines:** Deadlines are assigned `null` unless directly grounded in explicit source text.
5. **Separation of Tasks:** Proposed next tasks remain distinct from existing confirmed tasks.

---

## 5. Running the Server

Run the development server from the repository root:

```bash
python -m uvicorn app.main:app --reload --port 8001 --app-dir aiml
```

- **API Base:** [http://127.0.0.1:8001](http://127.0.0.1:8001)
- **Health Check:** [http://127.0.0.1:8001/health](http://127.0.0.1:8001/health)
- **Swagger Documentation:** [http://127.0.0.1:8001/docs](http://127.0.0.1:8001/docs)
- **ReDoc Documentation:** [http://127.0.0.1:8001/redoc](http://127.0.0.1:8001/redoc)

---

## 6. Running Tests

Run the test suite deterministically from the repository root (all Groq API calls are mocked):

```bash
python -m pytest aiml/tests -v
```

### Project chatbot

`POST /api/v1/project-chat` generates a plain-text answer over retrieved sources supplied by the authorized Node backend. It uses a dedicated NEW_GROQ_API_KEY with the existing GROQ_MODEL and GROQ_TIMEOUT settings, validates citations, and treats retrieved content as untrusted data. The website calls the authenticated backend's project chat API; it does not supply arbitrary project evidence directly. Deploy this endpoint alongside the Node chat route before using the deployed chatbot.

Set NEW_GROQ_API_KEY in aiml/.env locally and on the Python AI Render service for deployment, then restart/redeploy that service. Project chat never falls back to GROQ_API_KEY; other AI features continue using GROQ_API_KEY.
