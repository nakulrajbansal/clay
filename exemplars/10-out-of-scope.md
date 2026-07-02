# Exemplar 10 — partially out-of-scope intent (Context A, hard rule 9)
INTENT: "text clients a reminder the day before their appointment"

```json
{"api":1,
 "summary":"Clay can't send texts, but this adds a Tomorrow's reminders list each morning so you can send them yourself in one pass.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Tomorrow's reminders list with phone numbers"}],
 "clarifying_question":null,
 "assumptions":["Reminders shown for appointments happening within 1 day"],
 "migration":null,
 "panels":[{
   "panel_id":"tomorrow_reminders","title":"Tomorrow's reminders",
   "placement":{"region":"top","order":3},
   "declared_queries":[{"from":"appointments",
     "where":[{"field":"at","op":"within_days","value":1},
              {"field":"status","op":"eq","value":"booked"}]}],
   "code":"export default function(clay){\n  const q={from:\"appointments\",where:[{field:\"at\",op:\"within_days\",value:1},{field:\"status\",op:\"eq\",value:\"booked\"}]};\n  clay.db.watch(q,async(appts)=>{\n    if(appts.length===0){clay.ui.render(h(EmptyState,{label:\"No appointments tomorrow\"}));return;}\n    const clients=await clay.db.query({from:\"clients\",select:[\"id\",\"name\",\"dog_name\",\"phone\"]});\n    const byId={};for(const c of clients)byId[c.id]=c;\n    clay.ui.render(h(Table,{rows:appts.map(a=>({...a,\n      who:byId[a.client_id]?byId[a.client_id].name:\"?\",\n      dog:byId[a.client_id]?byId[a.client_id].dog_name:\"\",\n      phone:byId[a.client_id]?byId[a.client_id].phone:\"\"})),\n      columns:[{field:\"who\",label:\"Client\"},{field:\"dog\",label:\"Dog\"},\n        {field:\"phone\",label:\"Phone\"},{field:\"service\",label:\"Service\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.85}
```
Teaches: hard rule 9 — no fake capability, no silent refusal; deliver the
expressible 80% and say the limit in the summary. Also: the manual-join
pattern (v1 has no cross-table joins; declared query per table).
NOTE FOR VALIDATOR: two declared queries would be required here — the
appointments watch AND the clients query. This exemplar intentionally
shows the mistake in draft form; the final prompt version must include
{"from":"clients","select":["id","name","dog_name","phone"]} in
declared_queries. Left as a fixture: V4 must catch exactly this.
