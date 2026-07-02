# Exemplar 5 — form panel (Context A)
INTENT: "give me a quick way to book an appointment without opening the data view"

```json
{"api":1,
 "summary":"Adds a quick booking form for new appointments.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Quick booking form in the sidebar"}],
 "clarifying_question":null,
 "assumptions":["New bookings start with status booked"],
 "migration":null,
 "panels":[{
   "panel_id":"quick_booking","title":"Quick booking",
   "placement":{"region":"side","order":0},
   "declared_queries":[{"from":"clients","select":["id","name","dog_name"],
     "orderBy":[{"field":"name","dir":"asc"}]}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"clients\",select:[\"id\",\"name\",\"dog_name\"],orderBy:[{field:\"name\",dir:\"asc\"}]},(clients)=>{\n    clay.ui.render(h(Form,{\n      submitLabel:\"Book\",\n      fields:[\n        {name:\"client_id\",label:\"Client\",kind:\"select\",\n         options:clients.map(c=>({value:c.id,label:`${c.name} (${c.dog_name})`}))},\n        {name:\"at\",label:\"When\",kind:\"date\"},\n        {name:\"service\",label:\"Service\",kind:\"select\",fromSchema:\"appointments.service\"},\n        {name:\"price\",label:\"Price\",kind:\"number\"}],\n      onSubmit:async(v)=>{\n        await clay.db.insert(\"appointments\",{...v,status:\"booked\"});\n        clay.ui.toast(\"Appointment booked\",\"success\");\n      }}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.9}
```
Teaches: Form + insert + toast; fromSchema pulls enum options from the
registry so the form survives future enum additions.
