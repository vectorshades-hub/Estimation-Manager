# Estimation Manager

A web tool for preparing steel detailing estimation charts and storing them in MongoDB.
Each estimation can be downloaded as an Excel "ESTIMATION CHART" with the same layout as
`26-149 AURORA ACC_output sample.xlsx`.

## Setup
1. Make sure MongoDB is running (default `mongodb://127.0.0.1:27017`).
2. Adjust `.env` if needed:
   ```
   MONGODB_URI=mongodb://127.0.0.1:27017/estimation_manager
   PORT=3000
   ```
3. Install and run:
   ```
   npm install        # behind a corporate proxy: $env:NODE_OPTIONS='--use-system-ca' first
   npm start
   ```
4. Open http://localhost:3000

## What an estimation holds
- **Details:** No. (auto-suggested as `YY-NNN`, e.g. `26-150`), date, project name, client, done by, status, due date, contact person/email, internal notes.
- **Submission details:** scope, complexity, deliverables, coordination needed, duration (weeks), tonnage for client, assumptions, remark.
- **SharePoint links:** one or more folder links for the submission documents (shown as a *Folder* button in the list).
- **Estimation chart:** up to 21 drawing sheet columns (Excel columns B–V) × 26 item rows (Beam 1/1 … Misc .in Hrs).
  Each row's hours = total qty × minutes ÷ divisor. Minutes and divisor can be changed per estimation.
- **No. of drawings:** calculated per type (COL, BEAM, BRACE, …). Any type can be overridden; AB / LINTEL / ERE are manual.
- **Tonnage expected** = total hours ÷ hours per tonnage (default 2.5). Time per drawing = total hours ÷ total drawings.
- Additional hours note, Arch / Span / Weight boxes, struct and misc description lists, and exclusions.

## Users and sign-in
**Currently switched off** (`AUTH_ENABLED=false` in `.env`): no login, everyone has full access. Set `AUTH_ENABLED=true` and restart to turn it on.

The first time the app is opened (no users yet) it asks you to create the **Admin** account. After that everyone signs in.
Admin adds users on the **Users** page (top menu) and can change roles, reset passwords and disable accounts.

| Role | Can do |
|---|---|
| Member | View / create / edit estimations, downloads, reply email |
| Team Leader | + mark Won / Lost, delete estimations, export the estimation list |
| Manager | + manage the client list (import, priority, edit, delete, export) |
| Admin | + manage users |

Rules are enforced by the server (`lib/auth.js`, `requireRole`). Passwords are stored as scrypt hashes; sessions last 12 hours;
5 wrong passwords lock that login for 5 minutes. There must always be at least one active Admin.
If the Admin password is lost, delete the user from the `users` collection in MongoDB and open the app to run setup again.

## Clients and "less value jobs"
- **Clients** page (top menu): import an Excel (.xlsx) or CSV client list, mark priority clients (★), add / rename / delete.
  The first column headed "Client"/"Name" is read; an optional "Priority" column (Yes/No) sets priority. A template is downloadable.
- The client name field in an estimation is a drop-down of this list, but any new name can be typed; new names are added to the list on save.
- An estimation is marked **Less value job** when the client is **not** a priority client **and** total hours are **below 175**
  (`LESS_VALUE_HOURS` in `public/calc.js`). The flag is evaluated live, so changing a client's priority updates it immediately.

## Reply email
In the editor, **✉ Reply Email** builds the reply ("Please find attached excel sheet of … project." + ITEM/DETAILS table).
Click **Copy email**, open the client's mail in Outlook, click **Reply**, paste, and attach the Excel.
Greeting and signature are remembered per browser.

The calculation logic lives in `public/calc.js` and is shared by the browser and the server, so the GUI totals
and the Excel output always agree. The Excel layout is built in `lib/excel.js`.

## API
| Method | Path | Description |
|---|---|---|
| GET | `/api/estimations?q=&status=&value=&from=&to=` | List / search / filter |
| GET | `/api/estimations/export?q=&status=&value=less\|priority&from=&to=` | Export filtered list to Excel (AutoFilter + totals) |
| GET | `/api/estimations/stats/summary` | Totals and per-status counts |
| GET | `/api/estimations/next-no` | Suggested next No. |
| GET | `/api/estimations/:id` | Get one |
| GET | `/api/estimations/:id/excel` | Download estimation chart (.xlsx) |
| POST | `/api/estimations` | Create |
| PUT | `/api/estimations/:id` | Update |
| DELETE | `/api/estimations/:id` | Delete |
