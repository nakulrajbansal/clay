# Archetype app contexts (the S1 payloads exemplars run against)

## Context A — "Groom" (grooming CRM; persona P1)
registry:
  clients(name text req, phone text, dog_name text, breed text,
          last_visit date, notes text)
  appointments(client_id text req, at date req, service enum[bath,full_groom,
          nails], price number, status enum[booked,done,no_show])
panels:
  client_list (main/0): Table over clients, orderBy last_visit desc
  upcoming (top/0): Table over appointments where within_days(at,14),
          status eq booked

## Context B — "Track" (PMO tracker; persona P2)
registry:
  projects(name text req, owner text, status enum[green,amber,red],
           next_milestone date, slipped_milestones integer,
           open_risks integer)
panels:
  project_table (main/0): Table over projects, all fields, sortable
  status_counts (top/0): MetricCards via aggregate count by status

## Context C — "Log" (reading log; persona P3)
registry:
  books(title text req, author text, pages integer, started date,
        finished date, rating integer)
panels:
  book_list (main/0): Table over books orderBy finished desc
