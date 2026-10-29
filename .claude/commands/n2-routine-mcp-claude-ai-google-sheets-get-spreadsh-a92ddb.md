---
description: "A routine agents here run again and again, learned from its repeated successful runs: mcp:claude_ai_Google_Sheets/get_spreadsheet `fields=<array> spreadsheetId={spreadsheetid}` → mcp:claude_ai_Google_Sheets/update_formulas `formulas=<array> range={range}!A1:{untitled} spreadsheetId={spreadsheetid}` → mcp:claude_ai_Google_Sheets/update_spreadsheet `requests=<array> spreadsheetId={spreadsheetid}`. Parameters: {spreadsheetid} (e.g. 18DZ8y8vhGgc-UlWFNPRGKFxkze2fySGrZHg9U9ipLp8, 1y2BjaLPC6YF_MRZpOYEsUPk3mXPiopfq8pEDb_5CKeo; given by the asker); {untitled} (e.g. K22, K16, L19; given by the asker); {range} (e.g. Untitled, Non-Prod; given by the asker)."
---

# routine-mcp-claude-ai-google-sheets-get-spreadsh-a92ddb

Confidence: 0% (0 runs)


# Routine Mcp Claude Ai Google Sheets Get Spreadsh A92ddb

A routine agents here run again and again, learned from its repeated successful runs: mcp:claude_ai_Google_Sheets/get_spreadsheet `fields=<array> spreadsheetId={spreadsheetid}` → mcp:claude_ai_Google_Sheets/update_formulas `formulas=<array> range={range}!A1:{untitled} spreadsheetId={spreadsheetid}` → mcp:claude_ai_Google_Sheets/update_spreadsheet `requests=<array> spreadsheetId={spreadsheetid}`. Parameters: {spreadsheetid} (e.g. 18DZ8y8vhGgc-UlWFNPRGKFxkze2fySGrZHg9U9ipLp8, 1y2BjaLPC6YF_MRZpOYEsUPk3mXPiopfq8pEDb_5CKeo; given by the asker); {untitled} (e.g. K22, K16, L19; given by the asker); {range} (e.g. Untitled, Non-Prod; given by the asker).

## When to use

the next command is mcp:claude_ai_Google_Sheets/get_spreadsheet `fields=<array> spreadsheetId={spreadsheetid}`

## Steps

1. mcp:claude_ai_Google_Sheets/get_spreadsheet `fields=<array> spreadsheetId={spreadsheetid}`
2. mcp:claude_ai_Google_Sheets/update_formulas `formulas=<array> range={range}!A1:{untitled} spreadsheetId={spreadsheetid}`
   - Pitfall: `` failed
3. mcp:claude_ai_Google_Sheets/update_spreadsheet `requests=<array> spreadsheetId={spreadsheetid}`

## Done when

- the last step (mcp:claude_ai_Google_Sheets/update_spreadsheet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-mcp-claude-ai-google-sheets-get-spreadsh-a92ddb", outcome="success/failure")
