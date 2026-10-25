# Built in AI model and account connection

nDimensions.AI owns model selection, compatibility testing, inference settings and
the rate schedule. End users connect a Google AI Studio key and review the evidence
they want to use. They do not enter model IDs, token prices or rate-card labels.

## Selected model

Release 0.8.0-rc.3 selects **Gemini 3.6 Flash** (`gemini-3.6-flash`). Google lists it
as stable and available for production use, with image input and structured output.
[Google model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash).

Live testing with a supplied credential found that 3.8 generation timed out in this
account, while 3.6 passed the identical screenshot/JSON/source-reference fixture in
about 2.4 seconds. A complete live extraction, composition and Word-export fixture
also passed, preserving both demonstrated numeric values, real image bytes and
source links. This is fixture qualification, not proof of the BRD's business metrics.

The adapter uses low thinking and the provider's default temperature. Provider
configuration lives in `common/webinar/provider-profile.ts`; the connection form
cannot change it. [Google Gemini 3 guidance](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3).

## Account connection

**Connect and test** makes a non-generating model-access request with a 45-second
maximum deadline. It verifies that the account can access the selected model and
its required token limits, then encrypts and saves the credential. It does not
require a billable generation request during setup. Screenshot/JSON qualification
belongs to the developer's test workflow.

Keys are opaque printable strings. Dotted Google auth keys and legacy keys are
accepted; embedded whitespace and header control characters are rejected. Requests
send credentials in the `x-goog-api-key` header. Raw keys never enter source files,
operation receipts or diagnostic artifacts. [Google key documentation](https://ai.google.dev/gemini-api/docs/api-key).

Old encrypted keys are retained when a manual profile or earlier model profile is
opened. The user can check the saved key once with the supported model. A failed
replacement leaves the working connection intact. Timeout and access failures use
different error messages.

## Generation reliability

The serving schema contains structural types and required fields. Expensive nested
array and numeric bounds remain enforced by strict local Zod validation, reducing
constrained-decoder rejection without relaxing the application's acceptance rules.
Source IDs, timestamps and project ownership are validated separately.

If step extraction succeeds but optional speech polishing is unavailable, preserve
the extracted narration in an editable draft, add a blocking speech-review flag,
and retain uncertain cost reservations. Never replay an uncertain request
implicitly. A live retry later completed both model stages successfully.

## Automatic cost estimates

The app uses published standard paid rates conservatively, including thinking
output. Through 31 December 2026 the estimate uses USD 0.75 per million input tokens
and USD 3.75 per million output tokens. The published 1 January 2027 schedule changes
these to USD 1.50 and USD 7.50. Effective schedules use UTC and enter the provider
profile hash. Free-tier usage may cost less. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).

Maintainers review future price/model changes and ship configuration updates.
Project spending limits remain a user choice. No shared company API secret is
embedded in the app. Five real rehearsals and business accuracy/productivity
measurements remain separate acceptance work.
