// Supply Closet Inventory API
//
// GET  /api/supply-closet              → all items grouped by category
// POST /api/supply-closet               → add an item     (auth required)
// PATCH /api/supply-closet?id=N         → update an item  (auth required)
// DELETE /api/supply-closet?id=N        → delete an item  (auth required)
//
// Authorization:
//   - GET: any authenticated @rootsandwingsindy.com Google user
//   - POST/PATCH/DELETE: only whoever is named as "Supply Coordinator" in
//     the volunteer-committees tab of the master sheet, OR the
//     communications@ super user. See api/_permissions.js — coordinator
//     identity is looked up live from the sheet (cached 5 min) so no env
//     var needs updating when the role changes hands.

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, getRoleHolderEmail, canImpersonate, activeSchoolYear, isSuperUser, isBoardMember } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { sendToUser, broadcastAll } = require('./_push');
const { touchTodos } = require('./_todos'); // #368
const { resolveFamily } = require('./_family');
const { allocateOrderLines, allocateBackorderedLines, orderTotalCents, needsOrderingQty, normalizeLines,
        splitQuickSaleLines, ledgerSignedCents, financeSummary, schoolYearBounds, normalizeLedgerEntry,
        orderFeeCents } = require('./_merch');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const VALID_CATEGORIES = ['permanent', 'currently_available', 'classroom_cabinet', 'game_closet', 'member_lending'];
const VALID_QTY_LEVELS = ['empty', 'low', 'medium', 'high'];
const VALID_OFFER_TYPES = ['lend', 'donate'];
const VALID_LOAN_PURPOSES = ['class', 'event', 'personal'];

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await verifyBearer(authHeader.slice(7));
    const payload = ticket.getPayload();
    const email = payload.email || '';
    const domain = email.split('@')[1] || '';
    if (domain !== ALLOWED_DOMAIN) return null;
    return { email: email, name: payload.name || '' };
  } catch (e) {
    return null;
  }
}

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured');
  }
  return neon(process.env.DATABASE_URL);
}

// The email whose permissions apply to this request — the View-As target
// when impersonating, else the real login. Same pattern as
// api/curriculum.js actingEmailFor (and the class-inspiration fix,
// 5fa4fac): view_as comes from the query or body and is honored only for
// canImpersonate callers (super users on prod; any signed-in member on
// dev/preview). Fixes #43/#34 — the write gate checked the RAW login, so
// a tester acting as the Supply Coordinator via View As saw the editor UI
// (client checks the acting identity) but every write 403'd.
function actingEmailFor(user, req) {
  const realEmail = (user && user.email) || '';
  const va = String((req.query && req.query.view_as) || (req.body && req.body.view_as) || '').trim().toLowerCase();
  if (va && (va.split('@')[1] || '') === ALLOWED_DOMAIN && canImpersonate(realEmail)) return va;
  return realEmail;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Daily cron (vercel.json): loan packing-list / return / overdue
  // reminders. Runs BEFORE member auth — same UA/CRON_SECRET gate as
  // tour.js handleReconcileCron.
  if (req.query.cron === 'loan-reminders') return handleLoanRemindersCron(req, res);

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Actions that any authenticated member can perform:
  //   POST ?id=N&action=flag                 (mark an item as needing restock)
  //   GET/POST ?action=loans / loan-*        (Lending Library — each handler
  //                                           does its own ownership checks)
  //   POST/PATCH/DELETE on member_lending items they OWN (checked below)
  // Everything else that isn't GET is restricted to the Supply Coordinator
  // or the communications@ super user.
  const isMemberFlag = req.method === 'POST' && req.query.action === 'flag';
  const isLoanAction = ['loan-request', 'loan-respond', 'loan-status',
    'loan-requests', 'loan-request-add', 'loan-request-pledge', 'loan-request-close'].indexOf(req.query.action) !== -1
    // #139 bring-* / #140+#156 liaison-* actions carry their own
    // liaison/self checks below.
    || String(req.query.action || '').indexOf('bring-') === 0
    || String(req.query.action || '').indexOf('liaison-') === 0;
  // #351 Merch Desk: merch-* actions do their own gating inside
  // handleMerchDeskActions (member actions are family-scoped; manager
  // actions gate on the merch_manage capability / board / super user) —
  // the Supply-Coordinator write gate below must not swallow them.
  const isMerchAction = String(req.query.action || '').indexOf('merch-') === 0;
  // Gate writes on the ACTING identity (View-As target when a
  // canImpersonate caller sends view_as, else the real login) — #43.
  const actingEmail = actingEmailFor(user, req);
  // 'supply_closet_edit' — defaults to the Supply Coordinator; editable
  // in the Permissions admin table. Resolved once; the lending branches
  // below use it as the "coordinator override" bit.
  let coordAllowed = false;
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    coordAllowed = await hasCapability(actingEmail, 'supply_closet_edit');
  }
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && !isMemberFlag && !isLoanAction && !isMerchAction && !coordAllowed) {
    // Members may still create/edit/delete their OWN Lending Library
    // items. POST: only when the body says member_lending (ownership is
    // forced server-side below). PATCH/DELETE: only when the target row
    // is a member_lending item they own — checked here so every other
    // path keeps the coordinator-only 403.
    const bodyCat = String((req.body && req.body.category) || '');
    let lendingOwnerOk = false;
    if (req.method === 'POST' && !req.query.action && bodyCat === 'member_lending') {
      lendingOwnerOk = true;
    } else if ((req.method === 'PATCH' || req.method === 'DELETE') && req.query.id && !req.query.action) {
      const sqlGate = getSql();
      const target = await sqlGate`SELECT category, held_by_email FROM supply_closet WHERE id = ${parseInt(req.query.id, 10) || 0}`;
      lendingOwnerOk = target.length > 0
        && target[0].category === 'member_lending'
        && String(target[0].held_by_email || '').toLowerCase() === String(actingEmail).toLowerCase();
    }
    if (!lendingOwnerOk) {
      return res.status(403).json({ error: 'Only the Supply Coordinator can modify the supply closet.' });
    }
  }

  try {
    const sql = getSql();

    // ── Supply Locations (action=locations) ──
    // MUST be handled before the generic method branches below, otherwise
    // GET /api/supply-closet?action=locations falls into the item list
    // handler and the frontend gets undefined locations.
    if (req.query.action === 'locations') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT id, name, sort_order FROM supply_locations ORDER BY sort_order, name`;
        return res.status(200).json({ locations: rows });
      }
      if (req.method === 'POST') {
        const name = String((req.body && req.body.name) || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        if (name.length > 200) return res.status(400).json({ error: 'name too long' });
        const maxOrder = await sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM supply_locations`;
        const inserted = await sql`INSERT INTO supply_locations (name, sort_order) VALUES (${name}, ${maxOrder[0].next}) RETURNING id, name, sort_order`;
        return res.status(201).json({ location: inserted[0] });
      }
      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const name = String((req.body && req.body.name) || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        const old = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
        if (old.length === 0) return res.status(404).json({ error: 'Not found' });
        const updated = await sql`UPDATE supply_locations SET name = ${name} WHERE id = ${id} RETURNING id, name, sort_order`;
        if (old[0].name !== name) await sql`UPDATE supply_closet SET location = ${name} WHERE location = ${old[0].name}`;
        return res.status(200).json({ location: updated[0] });
      }
      if (req.method === 'DELETE') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const toDelete = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
        if (toDelete.length === 0) return res.status(404).json({ error: 'Not found' });

        // Optional: reassign items at this location to `moveTo` before
        // deleting. If omitted (or empty), items get their location cleared.
        // Validate moveTo against the set of known locations so we don't
        // quietly land items in a typo'd spot.
        const rawMoveTo = (req.query.moveTo === undefined || req.query.moveTo === null)
          ? ''
          : String(req.query.moveTo);
        let moveTo = rawMoveTo.trim();
        if (moveTo) {
          const match = await sql`SELECT name FROM supply_locations WHERE LOWER(name) = LOWER(${moveTo}) AND id <> ${id} LIMIT 1`;
          if (match.length === 0) {
            return res.status(400).json({ error: 'moveTo is not a valid location' });
          }
          moveTo = match[0].name;
        }

        const reassigned = await sql`
          UPDATE supply_closet
          SET location = ${moveTo}
          WHERE location = ${toDelete[0].name}
          RETURNING id
        `;
        const deleted = await sql`DELETE FROM supply_locations WHERE id = ${id} RETURNING id`;
        return res.status(200).json({
          ok: true,
          moved_count: reassigned.length,
          moved_to: moveTo
        });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Merch Desk (#351): catalog, orders, stock, quick-sale ──
    if (isMerchAction) {
      return handleMerchDeskActions(req, res, sql, user, actingEmail);
    }

    // ── Things to Bring (#139): liaison-posted group items + claims ──
    if (String(req.query.action || '').indexOf('bring-') === 0
      || String(req.query.action || '').indexOf('liaison-') === 0) {
      return handleBringActions(req, res, sql, user, actingEmail);
    }

    // ── Lending Library: loans list / request / respond / status ──
    if (req.query.action === 'loans' || isLoanAction) {
      return handleLoanActions(req, res, sql, user, actingEmail, coordAllowed);
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, item_name, location, category, notes, sort_order, updated_at, updated_by,
               held_by, held_by_email, offer_type, donated_at, donated_to,
               needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
               quantity_level, quantity_updated_at, quantity_updated_by
        FROM supply_closet
        ORDER BY category, sort_order, item_name
      `;
      const grouped = { permanent: [], currently_available: [], classroom_cabinet: [], game_closet: [], member_lending: [] };
      rows.forEach(r => {
        if (grouped[r.category]) grouped[r.category].push(r);
      });
      // Open bookings on Lending Library items, so the browse list can show
      // availability and the request form can avoid double-booking.
      const bookings = await sql`
        SELECT l.id, l.item_id, l.kind, l.status, l.start_date, l.end_date,
               l.borrower_name, l.borrower_email
        FROM supply_loans l
        JOIN supply_closet c ON c.id = l.item_id
        WHERE c.category = 'member_lending'
          AND l.status IN ('requested', 'approved', 'handed_off')
        ORDER BY l.start_date NULLS LAST, l.id
      `;
      return res.status(200).json({ items: grouped, bookings: bookings });
    }

    // ── Restock flag (any authenticated member) ──
    // POST /api/supply-closet?id=N&action=flag
    // Idempotent: if already flagged, returns ok without creating a duplicate
    // notification. Notifies the current Supply Coordinator via the shared
    // notifications table + web push.
    if (req.method === 'POST' && req.query.action === 'flag') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });

      const existing = await sql`SELECT id, item_name, needs_restock FROM supply_closet WHERE id = ${id}`;
      if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });

      if (existing[0].needs_restock) {
        return res.status(200).json({ ok: true, already_flagged: true });
      }

      const flaggerLabel = user.name || user.email;
      // #125-3: classroom-cabinet flags carry WHICH classroom (room name
      // from Facilities > Rooms, picked client-side at flag time).
      const flagRoom = String((req.body && req.body.room) || '').trim().slice(0, 120);
      const updated = await sql`
        UPDATE supply_closet
        SET needs_restock = TRUE,
            restock_flagged_at = NOW(),
            restock_flagged_by = ${flaggerLabel},
            restock_room = ${flagRoom}
        WHERE id = ${id}
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by,
                  needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
                  quantity_level, quantity_updated_at, quantity_updated_by
      `;

      // Notify the Supply Coordinator (best-effort; failures don't block flag)
      try {
        const coordEmail = await getRoleHolderEmail('Supply Coordinator');
        if (coordEmail) {
          const title = 'Supply needs restock: ' + existing[0].item_name;
          const body = flaggerLabel + ' flagged ' + existing[0].item_name + ' as low/empty'
            + (flagRoom ? ' — ' + flagRoom : '');
          await sql`
            INSERT INTO notifications (recipient_email, type, title, body, link_url)
            VALUES (${coordEmail}, 'supply_low', ${title}, ${body}, ${'/members.html#supply-' + id})
          `;
          await sendToUser(sql, coordEmail, {
            title: title,
            body: body,
            url: '/members.html#supply-' + id
          });
        }
      } catch (notifyErr) {
        console.error('Supply flag notification failed:', notifyErr);
      }

      return res.status(200).json({ item: updated[0] });
    }

    // ── Clear restock flag (coordinator) ──
    // POST /api/supply-closet?id=N&action=unflag
    if (req.method === 'POST' && req.query.action === 'unflag') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });
      const updated = await sql`
        UPDATE supply_closet
        SET needs_restock = FALSE,
            restock_flagged_at = NULL,
            restock_flagged_by = '',
            restock_room = ''
        WHERE id = ${id}
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by,
                  needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
                  quantity_level, quantity_updated_at, quantity_updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ item: updated[0] });
    }

    // ── Set quantity level (coordinator, informational only) ──
    // PATCH /api/supply-closet?id=N&action=quantity  body: { quantity_level }
    if (req.method === 'PATCH' && req.query.action === 'quantity') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });
      const body = req.body || {};
      const raw = body.quantity_level;
      const level = raw === null || raw === '' ? null : String(raw);
      if (level !== null && VALID_QTY_LEVELS.indexOf(level) === -1) {
        return res.status(400).json({ error: 'Invalid quantity_level' });
      }
      const updated = await sql`
        UPDATE supply_closet
        SET quantity_level = ${level},
            quantity_updated_at = NOW(),
            quantity_updated_by = ${actingEmail}
        WHERE id = ${id}
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by,
                  needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
                  quantity_level, quantity_updated_at, quantity_updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ item: updated[0] });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const item_name = String(body.item_name || '').trim();
      const location = String(body.location || '').trim();
      const category = String(body.category || '').trim();
      const notes = String(body.notes || '').trim();
      let held_by = String(body.held_by || '').trim().slice(0, 200);
      let held_by_email = String(body.held_by_email || '').trim().toLowerCase().slice(0, 200);
      let offer_type = String(body.offer_type || 'lend').trim();

      if (!item_name) return res.status(400).json({ error: 'item_name is required' });
      if (VALID_CATEGORIES.indexOf(category) === -1) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      if (VALID_OFFER_TYPES.indexOf(offer_type) === -1) offer_type = 'lend';
      if (item_name.length > 200 || location.length > 200 || notes.length > 500) {
        return res.status(400).json({ error: 'Field too long' });
      }
      // Non-coordinators reached here only via the lending gate: the item
      // is theirs, whatever the body claims (owner = held_by fields).
      if (category === 'member_lending' && !coordAllowed) {
        held_by_email = String(actingEmail).toLowerCase();
        if (!held_by) held_by = user.name || actingEmail;
      }

      const inserted = await sql`
        INSERT INTO supply_closet (item_name, location, category, notes, held_by, held_by_email, offer_type, updated_by)
        VALUES (${item_name}, ${location}, ${category}, ${notes}, ${held_by}, ${held_by_email}, ${offer_type}, ${actingEmail})
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by,
                  held_by, held_by_email, offer_type, donated_at, donated_to,
                  needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
                  quantity_level, quantity_updated_at, quantity_updated_by
      `;
      return res.status(201).json({ item: inserted[0] });
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });
      const body = req.body || {};
      const item_name = String(body.item_name || '').trim();
      let location = String(body.location || '').trim();
      let category = String(body.category || '').trim();
      const notes = String(body.notes || '').trim();
      let held_by = String(body.held_by || '').trim().slice(0, 200);
      let held_by_email = String(body.held_by_email || '').trim().toLowerCase().slice(0, 200);
      let offer_type = String(body.offer_type || 'lend').trim();

      if (!item_name) return res.status(400).json({ error: 'item_name is required' });
      if (VALID_CATEGORIES.indexOf(category) === -1) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      if (VALID_OFFER_TYPES.indexOf(offer_type) === -1) offer_type = 'lend';
      if (item_name.length > 200 || location.length > 200 || notes.length > 500) {
        return res.status(400).json({ error: 'Field too long' });
      }
      // Lending owners (non-coordinators) can rename/re-note/re-offer their
      // item but never move it out of the Lending Library or hand ownership
      // to someone else — the gate above verified the row is theirs.
      if (!coordAllowed) {
        category = 'member_lending';
        held_by_email = String(actingEmail).toLowerCase();
        if (!held_by) held_by = user.name || actingEmail;
      }

      const updated = await sql`
        UPDATE supply_closet
        SET item_name = ${item_name},
            location = ${location},
            category = ${category},
            notes = ${notes},
            held_by = ${held_by},
            held_by_email = ${held_by_email},
            offer_type = ${offer_type},
            updated_at = NOW(),
            updated_by = ${actingEmail}
        WHERE id = ${id}
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by,
                  held_by, held_by_email, offer_type, donated_at, donated_to,
                  needs_restock, restock_flagged_at, restock_flagged_by, restock_room,
                  quantity_level, quantity_updated_at, quantity_updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ item: updated[0] });
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });

      // A lending item that's currently out (or promised) can't be quietly
      // deleted — the borrower's record would vanish with it (loans cascade).
      // A COMPLETED donation (kind=donate, handed_off) is fine to delete —
      // that item's story is over (#135).
      const activeLoans = await sql`
        SELECT COUNT(*)::int AS n FROM supply_loans
        WHERE item_id = ${id}
          AND ((kind = 'borrow' AND status IN ('approved', 'handed_off'))
            OR (kind = 'donate' AND status = 'approved'))
      `;
      if (activeLoans[0].n > 0) {
        return res.status(409).json({ error: 'This item is currently lent out (or promised). Mark the loan returned or canceled first.' });
      }

      const deleted = await sql`DELETE FROM supply_closet WHERE id = ${id} RETURNING id`;
      if (deleted.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ ok: true, id: deleted[0].id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Supply closet API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════
// Things to Bring (#139, 2026-07-28) — group liaisons post items their
// age group needs at co-op (sign-up style, one family per spot, dated
// to a co-op day). Claims surface under the kid's class on Kid Schedule
// and on the Packing List (#138).
// ══════════════════════════════════════════════════════════════════

const BRING_GROUPS = ['Greenhouse', 'Saplings', 'Sassafras', 'Oaks', 'Maples', 'Birch', 'Cedars', 'Willows', 'Pigeons'];

// Liaison gate: the group's "<Group> Liaison" (or "<Group> Morning Class
// Liaison") role holder, the VP, or a super user.
async function canManageBringGroup(email, group) {
  if (isSuperUser(email)) return true;
  if (await canEditAsRole(email, 'Vice President')) return true;
  if (await canEditAsRole(email, group + ' Liaison')) return true;
  return await canEditAsRole(email, group + ' Morning Class Liaison');
}

// Slots arrive as [{label, capacity, note}] (same shape the collab
// section editor produces); config carries mode/hint/note_label plus the
// per-section co-op day (bring_date).
function normalizeBringSection(body) {
  const cfgIn = (body.config && typeof body.config === 'object') ? body.config : {};
  const config = {
    mode: cfgIn.mode === 'slots' ? 'slots' : 'bring',
    hint: String(cfgIn.hint || '').trim().slice(0, 300),
    note_label: String(cfgIn.note_label || '').trim().slice(0, 120),
    bring_date: /^\d{4}-\d{2}-\d{2}$/.test(String(cfgIn.bring_date || '')) ? cfgIn.bring_date : ''
  };
  let content = [];
  if (config.mode === 'slots' && Array.isArray(body.content)) {
    content = body.content.map(s => ({
      label: String((s && s.label) || '').trim().slice(0, 200),
      capacity: Math.max(0, Math.min(50, parseInt(s && s.capacity, 10) || 0)),
      note: String((s && s.note) || '').trim().slice(0, 300),
      // "everyone brings this" rows (white t-shirt for tie-dye day) —
      // announcement lines nobody claims.
      everyone: !!(s && s.everyone)
    })).filter(s => s.label).slice(0, 30);
  }
  return { config, content };
}

// Class-scope gate: the class's lead (submitter), the VP / Afternoon
// Class Liaison, or a super user.
async function canManageBringClass(sql, email, classId) {
  const rows = await sql`
    SELECT LOWER(submitted_by_email) AS lead, class_name, scheduled_session, status
    FROM class_submissions WHERE id = ${classId}
  `;
  if (rows.length === 0) return { ok: false };
  const cls = rows[0];
  let ok = cls.lead === email || isSuperUser(email);
  if (!ok) ok = await canEditAsRole(email, 'Vice President');
  if (!ok) ok = await canEditAsRole(email, 'Afternoon Class Liaison');
  return { ok, cls };
}

async function handleBringActions(req, res, sql, user, actingEmail) {
  const email = String(actingEmail).toLowerCase();
  const yr = activeSchoolYear(new Date());
  const body = req.body || {};

  if (req.query.action === 'bring-items') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const sections = await sql`
      SELECT id, class_group, scope, class_submission_id, class_name, session_number,
             type, title, config, content, is_open, sort_order
      FROM group_sections WHERE school_year = ${yr}
      ORDER BY class_group, sort_order, id
    `;
    const ids = sections.map(s => s.id);
    const signups = ids.length ? await sql`
      SELECT id, section_id, slot_index, shift_index, person_email, person_name, item_text, note
      FROM group_section_signups WHERE section_id = ANY(${ids})
      ORDER BY created_at, id
    ` : [];
    return res.status(200).json({ sections, signups, me: email, school_year: yr });
  }

  // ── #160 shared-facility bookings (Kitchen / Kitchen Annex / Pavilion) ──
  // Any signed-in member reads the grid; a group's liaison (or VP/super,
  // via canManageBringGroup) books weeks × hours for their group. The
  // facility_bookings UNIQUE constraint enforces one group per facility ×
  // session × week × hour; conflicts 409 with who holds it.
  const FACILITIES = ['Kitchen', 'Kitchen Annex', 'Pavilion'];
  if (req.query.action === 'liaison-facilities') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const rows = await sql`
      SELECT id, session_number, week_number, hour, facility, class_group
      FROM facility_bookings WHERE school_year = ${yr}
      ORDER BY session_number, week_number, hour, facility`;
    return res.status(200).json({ bookings: rows, facilities: FACILITIES, school_year: yr });
  }
  if (req.query.action === 'liaison-facility-book') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const fbGroup = String(body.group || '').trim();
    const fbFacility = String(body.facility || '').trim();
    const fbSess = parseInt(body.session, 10);
    const fbWeeks = (Array.isArray(body.weeks) ? body.weeks : []).map(w => parseInt(w, 10))
      .filter(w => Number.isFinite(w) && w >= 1 && w <= 5);
    const fbHours = (Array.isArray(body.hours) ? body.hours : []).filter(h => h === 'AM1' || h === 'AM2');
    if (BRING_GROUPS.indexOf(fbGroup) === -1) return res.status(400).json({ error: 'Unknown group' });
    if (FACILITIES.indexOf(fbFacility) === -1) return res.status(400).json({ error: 'Unknown facility' });
    if (!Number.isFinite(fbSess) || fbSess < 1 || fbSess > 5) return res.status(400).json({ error: 'session 1-5 required' });
    if (!fbWeeks.length || !fbHours.length) return res.status(400).json({ error: 'Pick at least one week and one hour.' });
    if (!(await canManageBringGroup(email, fbGroup))) {
      return res.status(403).json({ error: 'Only the ' + fbGroup + ' Liaison (or VP) can book for that group.' });
    }
    // All-or-nothing: report every taken slot before writing anything.
    const fbTaken = await sql`
      SELECT week_number, hour, class_group FROM facility_bookings
      WHERE school_year = ${yr} AND session_number = ${fbSess} AND facility = ${fbFacility}
        AND week_number = ANY(${fbWeeks}) AND hour = ANY(${fbHours})`;
    if (fbTaken.length) {
      const bits = fbTaken.map(t => 'week ' + t.week_number + ' ' + (t.hour === 'AM1' ? 'Hour 1' : 'Hour 2') + ' (' + t.class_group + ')');
      return res.status(409).json({ error: fbFacility + ' is already booked: ' + bits.join(', ') + '. Adjust your weeks/hours and try again.' });
    }
    for (const w of fbWeeks) {
      for (const h of fbHours) {
        await sql`
          INSERT INTO facility_bookings (school_year, session_number, week_number, hour, facility, class_group, booked_by)
          VALUES (${yr}, ${fbSess}, ${w}, ${h}, ${fbFacility}, ${fbGroup}, ${email})
          ON CONFLICT DO NOTHING`;
      }
    }
    return res.status(201).json({ ok: true });
  }
  if (req.query.action === 'liaison-facility-release') {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
    const fbId = parseInt(req.query.id, 10);
    if (!Number.isFinite(fbId)) return res.status(400).json({ error: 'id required' });
    const fbRows = await sql`SELECT id, class_group FROM facility_bookings WHERE id = ${fbId}`;
    if (!fbRows.length) return res.status(404).json({ error: 'Booking not found.' });
    if (!(await canManageBringGroup(email, fbRows[0].class_group))) {
      return res.status(403).json({ error: 'Only the ' + fbRows[0].class_group + ' Liaison (or VP) can release this booking.' });
    }
    await sql`DELETE FROM facility_bookings WHERE id = ${fbId}`;
    return res.status(200).json({ ok: true });
  }

  // ── #140 liaison per-kid notes (My Class card) ──
  // Liaison-only both ways: the notes are the liaison's private working
  // notes for their group, never shown to families.
  if (req.query.action === 'liaison-notes') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const group = String(req.query.group || '').trim();
    if (BRING_GROUPS.indexOf(group) === -1) return res.status(400).json({ error: 'Unknown group' });
    if (!(await canManageBringGroup(email, group))) {
      return res.status(403).json({ error: 'Only the ' + group + ' Liaison (or VP) can see these notes.' });
    }
    const rows = await sql`
      SELECT kid_key, note FROM liaison_kid_notes
      WHERE school_year = ${yr} AND class_group = ${group}
    `;
    return res.status(200).json({ notes: rows, school_year: yr });
  }

  // #156: the roster comes straight from the Morning Class Builder's
  // finalized placements — the community snapshot only carries kids whose
  // family has a season REGISTRATION row, which missed half the builder's
  // roster (13 of 25 on dev). kids join supplies current names + the real
  // family_email for client-side directory enrichment.
  if (req.query.action === 'liaison-roster') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const group = String(req.query.group || '').trim();
    if (BRING_GROUPS.indexOf(group) === -1) return res.status(400).json({ error: 'Unknown group' });
    if (!(await canManageBringGroup(email, group))) {
      return res.status(403).json({ error: 'Only the ' + group + ' Liaison (or VP) can see this roster.' });
    }
    const rows = await sql`
      SELECT COALESCE(NULLIF(k.first_name, ''), a.kid_first_name) AS kid_name,
             COALESCE(k.last_name, '') AS kid_last_name,
             LOWER(COALESCE(NULLIF(k.family_email, ''), a.family_email)) AS family_email
      FROM morning_class_assignments a
      LEFT JOIN kids k ON k.id = a.kid_id
      WHERE a.school_year = ${yr} AND LOWER(a.class_group) = LOWER(${group})
        AND a.finalized = TRUE
      ORDER BY 1
    `;
    // #250 (Erin): before the Grove Builder finalizes placements, the
    // grove's CURRENT kids are the expected roster — same fallback the
    // Co-op Coordination tables and the classmates modal already use, so
    // the liaison card can't show "no kids" while coordination shows some.
    if (rows.length === 0) {
      const fallback = await sql`
        SELECT first_name AS kid_name, COALESCE(last_name, '') AS kid_last_name,
               LOWER(family_email) AS family_email
        FROM kids WHERE LOWER(class_group) = LOWER(${group})
        ORDER BY 1
      `;
      return res.status(200).json({ roster: fallback, school_year: yr, placements_pending: true });
    }
    return res.status(200).json({ roster: rows, school_year: yr });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.query.action === 'liaison-note-save') {
    const group = String(body.class_group || '').trim();
    if (BRING_GROUPS.indexOf(group) === -1) return res.status(400).json({ error: 'Unknown group' });
    if (!(await canManageBringGroup(email, group))) {
      return res.status(403).json({ error: 'Only the ' + group + ' Liaison (or VP) can edit these notes.' });
    }
    const kidKey = String(body.kid_key || '').trim().toLowerCase().slice(0, 200);
    if (!kidKey) return res.status(400).json({ error: 'kid_key required' });
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!note) {
      await sql`DELETE FROM liaison_kid_notes WHERE school_year = ${yr} AND class_group = ${group} AND kid_key = ${kidKey}`;
      return res.status(200).json({ ok: true, deleted: true });
    }
    await sql`
      INSERT INTO liaison_kid_notes (school_year, class_group, kid_key, note, updated_by)
      VALUES (${yr}, ${group}, ${kidKey}, ${note}, ${email})
      ON CONFLICT (school_year, class_group, kid_key)
      DO UPDATE SET note = ${note}, updated_by = ${email}, updated_at = NOW()
    `;
    return res.status(200).json({ ok: true });
  }

  if (req.query.action === 'bring-section-save') {
    const scope = body.scope === 'class' ? 'class' : 'group';
    let group = '';
    let classId = null, className = '', sessNum = null;
    if (scope === 'group') {
      group = String(body.class_group || '').trim();
      if (BRING_GROUPS.indexOf(group) === -1) return res.status(400).json({ error: 'Unknown group' });
      if (!(await canManageBringGroup(email, group))) {
        return res.status(403).json({ error: 'Only the ' + group + ' Liaison (or VP) can edit this group’s lists.' });
      }
    } else {
      classId = parseInt(body.class_submission_id, 10);
      if (!Number.isInteger(classId) || classId < 1) return res.status(400).json({ error: 'class_submission_id required' });
      const gate = await canManageBringClass(sql, email, classId);
      if (!gate.cls) return res.status(404).json({ error: 'Class not found' });
      if (!gate.ok) return res.status(403).json({ error: 'Only the class lead (or VP / Afternoon Class Liaison) can edit this class’s list.' });
      className = gate.cls.class_name || '';
      sessNum = gate.cls.scheduled_session || null;
    }
    const title = String(body.title || '').trim().slice(0, 200) || (scope === 'class' ? 'Things to Bring' : 'Snack List');
    const { config, content } = normalizeBringSection(body);
    if (config.mode === 'slots' && content.length === 0) {
      return res.status(400).json({ error: 'Add at least one item (item | how many | details).' });
    }
    const id = body.id != null ? parseInt(body.id, 10) : null;
    let row;
    if (Number.isInteger(id) && id > 0) {
      // Scope/link fields are fixed at creation; edits touch content only.
      const upd = await sql`
        UPDATE group_sections
        SET title = ${title}, config = ${JSON.stringify(config)}::jsonb, content = ${JSON.stringify(content)}::jsonb,
            updated_by = ${email}, updated_at = NOW()
        WHERE id = ${id} AND school_year = ${yr}
          AND (${scope === 'group'} AND class_group = ${group} OR ${scope === 'class'} AND class_submission_id = ${classId})
        RETURNING *
      `;
      if (upd.length === 0) return res.status(404).json({ error: 'Section not found' });
      row = upd[0];
    } else {
      const ins = await sql`
        INSERT INTO group_sections (school_year, class_group, scope, class_submission_id, class_name, session_number, title, config, content, updated_by)
        VALUES (${yr}, ${group}, ${scope}, ${classId}, ${className}, ${sessNum},
                ${title}, ${JSON.stringify(config)}::jsonb, ${JSON.stringify(content)}::jsonb, ${email})
        RETURNING *
      `;
      row = ins[0];
    }
    return res.status(200).json({ section: row });
  }

  if (req.query.action === 'bring-section-delete') {
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
    const rows = await sql`SELECT scope, class_group, class_submission_id FROM group_sections WHERE id = ${id} AND school_year = ${yr}`;
    if (rows.length === 0) return res.status(404).json({ error: 'Section not found' });
    let allowed;
    if (rows[0].scope === 'class') {
      const gate = await canManageBringClass(sql, email, rows[0].class_submission_id);
      allowed = gate.ok;
    } else {
      allowed = await canManageBringGroup(email, rows[0].class_group);
    }
    if (!allowed) return res.status(403).json({ error: 'Only the list’s owner (or VP) can remove this.' });
    await sql`DELETE FROM group_sections WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  if (req.query.action === 'bring-claim') {
    const sid = parseInt(body.section_id, 10);
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'section_id required' });
    const secs = await sql`SELECT config, content FROM group_sections WHERE id = ${sid} AND school_year = ${yr}`;
    if (secs.length === 0) return res.status(404).json({ error: 'Section not found' });
    const cfg = secs[0].config || {};
    const name = String(body.person_name || '').trim().slice(0, 200) || user.name || email;
    if (cfg.mode === 'slots') {
      const idx = parseInt(body.slot_index, 10);
      const slots = Array.isArray(secs[0].content) ? secs[0].content : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= slots.length) return res.status(400).json({ error: 'slot_index required' });
      if (slots[idx] && slots[idx].everyone) return res.status(400).json({ error: 'Everyone brings that one — no sign-up needed.' });
      // #227 (Mock A): timed shifts scope the duplicate/capacity checks.
      const gShifts = Array.isArray(slots[idx] && slots[idx].shifts) ? slots[idx].shifts : [];
      let shIdx = null;
      if (gShifts.length) {
        shIdx = parseInt(body.shift_index, 10);
        if (!Number.isInteger(shIdx) || shIdx < 0 || shIdx >= gShifts.length) return res.status(400).json({ error: 'Pick which shift you can cover.' });
      }
      const claims = shIdx === null
        ? await sql`SELECT LOWER(person_email) AS em FROM group_section_signups WHERE section_id = ${sid} AND slot_index = ${idx}`
        : await sql`SELECT LOWER(person_email) AS em FROM group_section_signups WHERE section_id = ${sid} AND slot_index = ${idx} AND shift_index = ${shIdx}`;
      if (claims.some(c => c.em === email)) return res.status(200).json({ ok: true, already: true });
      const cap = shIdx === null
        ? (parseInt(slots[idx] && slots[idx].capacity, 10) || 0)
        : (parseInt(gShifts[shIdx] && gShifts[shIdx].capacity, 10) || 0);
      if (cap > 0 && claims.length >= cap) return res.status(409).json({ error: 'That spot just filled — thank you though!' });
      await sql`INSERT INTO group_section_signups (section_id, slot_index, shift_index, person_email, person_name)
                VALUES (${sid}, ${idx}, ${shIdx}, ${email}, ${name})`;
    } else {
      const item_text = String(body.item_text || '').trim().slice(0, 200);
      if (!item_text) return res.status(400).json({ error: 'Say what you’ll bring.' });
      const note = String(body.note || '').trim().slice(0, 300);
      await sql`INSERT INTO group_section_signups (section_id, person_email, person_name, item_text, note)
                VALUES (${sid}, ${email}, ${name}, ${item_text}, ${note})`;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.query.action === 'bring-unclaim') {
    const suId = parseInt(body.id, 10);
    if (!Number.isInteger(suId) || suId < 1) return res.status(400).json({ error: 'id required' });
    // Members remove their own; the group's liaison can tidy anyone's.
    const rows = await sql`
      SELECT s.id, LOWER(s.person_email) AS em, g.class_group
      FROM group_section_signups s JOIN group_sections g ON g.id = s.section_id
      WHERE s.id = ${suId}
    `;
    if (rows.length === 0) return res.status(200).json({ ok: true });
    if (rows[0].em !== email && !(await canManageBringGroup(email, rows[0].class_group))) {
      return res.status(403).json({ error: 'You can only remove your own sign-up.' });
    }
    await sql`DELETE FROM group_section_signups WHERE id = ${suId}`;
    return res.status(200).json({ ok: true });
  }

  // #225 (Colleen): edit a bring-mode sign-up in place — own, or the
  // group's liaison. Slot claims have nothing to edit.
  if (req.query.action === 'bring-update') {
    const suId = parseInt(body.id, 10);
    if (!Number.isInteger(suId) || suId < 1) return res.status(400).json({ error: 'id required' });
    const item_text = String(body.item_text || '').trim().slice(0, 200);
    if (!item_text) return res.status(400).json({ error: 'Say what you’ll bring.' });
    const note = String(body.note || '').trim().slice(0, 300);
    const rows = await sql`
      SELECT s.id, LOWER(s.person_email) AS em, s.item_text, g.class_group
      FROM group_section_signups s JOIN group_sections g ON g.id = s.section_id
      WHERE s.id = ${suId}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Sign-up not found.' });
    if (!rows[0].item_text) return res.status(400).json({ error: 'Slot sign-ups have nothing to edit.' });
    if (rows[0].em !== email && !(await canManageBringGroup(email, rows[0].class_group))) {
      return res.status(403).json({ error: 'You can only edit your own sign-up.' });
    }
    await sql`UPDATE group_section_signups SET item_text = ${item_text}, note = ${note} WHERE id = ${suId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}

// ══════════════════════════════════════════════════════════════════
// Lending Library (2026-07-28, Erin)
// ══════════════════════════════════════════════════════════════════

// In-app notification + web push, best-effort — a failed notification
// never blocks the loan action itself (same posture as the restock flag).
// #242: linkUrl (optional) drives where the in-app bell click lands. Defaults
// to '/members.html'; item-loan notifications pass 'lending:<loanId>' so the
// notification click opens the owner's approve/decline surface (the Workspace
// Lending card). The web-push url stays '/members.html' — the SW just opens
// the portal, and the bell handler does the in-app routing.
async function notifyMember(sql, email, title, body, type, linkUrl) {
  if (!email) return;
  try {
    await sql`
      INSERT INTO notifications (recipient_email, type, title, body, link_url)
      VALUES (${email}, ${type || 'lending'}, ${title}, ${body}, ${linkUrl || '/members.html'})
    `;
    await sendToUser(sql, email, { title: title, body: body, url: '/members.html' });
  } catch (e) {
    console.error('Lending notification failed:', e);
  }
}

function fmtLoanDates(loan) {
  if (!loan.start_date) return '';
  const f = (d) => {
    // DATE columns arrive as 'YYYY-MM-DD' strings from neon-http, but be
    // safe about Date objects too (toISOString, NOT String() — the local
    // "Mon Jul 27…" form would slice garbage).
    const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
    const [y, m, day] = s.split('-');
    return `${parseInt(m, 10)}/${parseInt(day, 10)}/${String(y).slice(2)}`;
  };
  return loan.end_date && String(loan.end_date) !== String(loan.start_date)
    ? `${f(loan.start_date)}–${f(loan.end_date)}`
    : f(loan.start_date);
}

// GET  ?action=loans                      → every loan where I'm owner or borrower
// POST ?action=loan-request&id=<itemId>   → ask to borrow / claim an item
// POST ?action=loan-respond&id=<loanId>   → owner approves or declines
// POST ?action=loan-status&id=<loanId>    → handed_off / returned / canceled
async function handleLoanActions(req, res, sql, user, actingEmail, coordAllowed) {
  const email = String(actingEmail).toLowerCase();

  if (req.query.action === 'loans') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const rows = await sql`
      SELECT l.*, c.item_name, c.offer_type
      FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE LOWER(l.owner_email) = ${email} OR LOWER(l.borrower_email) = ${email}
      ORDER BY l.requested_at DESC
      LIMIT 200
    `;
    // #135 (Lyndsey): the card also lists every item the member has in
    // the library so they can prune what they no longer have.
    const myItems = await sql`
      SELECT id, item_name, offer_type, notes, donated_at, donated_to
      FROM supply_closet
      WHERE category = 'member_lending' AND LOWER(held_by_email) = ${email}
      ORDER BY item_name
    `;
    return res.status(200).json({ loans: rows, my_items: myItems, me: email });
  }

  // ── #161 Lending Library REQUESTS ──
  // Members ask for items the library doesn't have. Every member gets a
  // bell row (+ push broadcast); any number of members pledge, with
  // quantity splits or open-ended commitments.
  if (req.query.action === 'loan-requests') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const lrRows = await sql`
      SELECT id, item_text, quantity, note, status, requested_by_email, requested_by_name, created_at
      FROM lending_requests WHERE status <> 'closed'
      ORDER BY created_at DESC LIMIT 200`;
    const lrIds = lrRows.map(r => r.id);
    const lrPledges = lrIds.length ? await sql`
      SELECT id, request_id, person_email, person_name, quantity, note
      FROM lending_request_pledges WHERE request_id = ANY(${lrIds})
      ORDER BY created_at, id` : [];
    return res.status(200).json({ requests: lrRows, pledges: lrPledges, me: email });
  }
  if (req.query.action === 'loan-request-add') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const raBody = req.body || {};
    const raItem = String(raBody.item_text || '').trim().slice(0, 200);
    if (!raItem) return res.status(400).json({ error: 'Say what you need.' });
    const raQtyRaw = parseInt(raBody.quantity, 10);
    const raQty = Number.isFinite(raQtyRaw) && raQtyRaw > 0 ? Math.min(raQtyRaw, 999) : null;
    const raNote = String(raBody.note || '').trim().slice(0, 300);
    const raP = await sql`SELECT first_name, last_name FROM people
      WHERE LOWER(email) = ${email} OR LOWER(personal_email) = ${email} LIMIT 1`;
    const raName = raP.length ? ((raP[0].first_name || '') + ' ' + (raP[0].last_name || '')).trim() : '';
    const raIns = await sql`
      INSERT INTO lending_requests (school_year, item_text, quantity, note, requested_by_email, requested_by_name)
      VALUES (${activeSchoolYear(new Date())}, ${raItem}, ${raQty}, ${raNote}, ${email}, ${raName})
      RETURNING id`;
    const raId = raIns[0].id;
    const raTitle = 'Lending Library request';
    const raBodyTxt = (raName || 'A member') + ' is looking for: ' + raItem + (raQty ? ' ×' + raQty : '') + '. Can you help?';
    try {
      const raMembers = await sql`SELECT DISTINCT LOWER(email) AS em FROM people WHERE COALESCE(email, '') <> ''`;
      for (const m of raMembers) {
        if (m.em === email) continue;
        await sql`INSERT INTO notifications (recipient_email, type, title, body, link_url)
          VALUES (${m.em}, 'lending_request', ${raTitle}, ${raBodyTxt}, '')`;
      }
      await broadcastAll(sql, { title: raTitle, body: raBodyTxt, tag: 'lend-req-' + raId, url: '/members.html' });
    } catch (nErr) { console.error('lending-request notify (non-fatal):', nErr); }
    return res.status(201).json({ ok: true, id: raId });
  }
  if (req.query.action === 'loan-request-pledge') {
    const rpBody = req.body || {};
    if (req.method === 'DELETE') {
      const rpDelId = parseInt(req.query.id, 10);
      if (!Number.isFinite(rpDelId)) return res.status(400).json({ error: 'id required' });
      const rpOwn = await sql`SELECT id, request_id, LOWER(person_email) AS em FROM lending_request_pledges WHERE id = ${rpDelId}`;
      if (!rpOwn.length) return res.status(404).json({ error: 'Pledge not found.' });
      if (rpOwn[0].em !== email && !coordAllowed) return res.status(403).json({ error: 'That pledge isn’t yours to remove.' });
      await sql`DELETE FROM lending_request_pledges WHERE id = ${rpDelId}`;
      await sql`UPDATE lending_requests SET status = 'open' WHERE id = ${rpOwn[0].request_id} AND status = 'fulfilled'`;
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rpReqId = parseInt(rpBody.request_id, 10);
    if (!Number.isFinite(rpReqId)) return res.status(400).json({ error: 'request_id required' });
    const rpRows = await sql`SELECT * FROM lending_requests WHERE id = ${rpReqId}`;
    if (!rpRows.length) return res.status(404).json({ error: 'Request not found.' });
    const rpReq = rpRows[0];
    if (rpReq.status === 'closed') return res.status(409).json({ error: 'This request is closed.' });
    let rpQty = parseInt(rpBody.quantity, 10);
    if (!Number.isFinite(rpQty) || rpQty < 1) rpQty = 1;
    if (rpReq.quantity != null) {
      const rpSum = await sql`SELECT COALESCE(SUM(quantity), 0)::int AS n FROM lending_request_pledges WHERE request_id = ${rpReqId}`;
      const rpRemaining = rpReq.quantity - rpSum[0].n;
      if (rpRemaining <= 0) return res.status(409).json({ error: 'This request is already fully covered — thank you though!' });
      rpQty = Math.min(rpQty, rpRemaining);
    }
    const rpP = await sql`SELECT first_name, last_name FROM people
      WHERE LOWER(email) = ${email} OR LOWER(personal_email) = ${email} LIMIT 1`;
    const rpName = rpP.length ? ((rpP[0].first_name || '') + ' ' + (rpP[0].last_name || '')).trim() : '';
    await sql`
      INSERT INTO lending_request_pledges (request_id, person_email, person_name, quantity, note)
      VALUES (${rpReqId}, ${email}, ${rpName}, ${rpQty}, ${String(rpBody.note || '').trim().slice(0, 300)})`;
    if (rpReq.quantity != null) {
      const rpAfter = await sql`SELECT COALESCE(SUM(quantity), 0)::int AS n FROM lending_request_pledges WHERE request_id = ${rpReqId}`;
      if (rpAfter[0].n >= rpReq.quantity) {
        await sql`UPDATE lending_requests SET status = 'fulfilled' WHERE id = ${rpReqId}`;
      }
    }
    // Requester hears about every pledge.
    try {
      const rpTitle = 'Someone can help — ' + rpReq.item_text;
      const rpTxt = (rpName || 'A member') + ' pledged ' + rpQty + ' for your request.';
      await sql`INSERT INTO notifications (recipient_email, type, title, body, link_url)
        VALUES (${String(rpReq.requested_by_email).toLowerCase()}, 'lending_pledge', ${rpTitle}, ${rpTxt}, '')`;
      await sendToUser(sql, String(rpReq.requested_by_email).toLowerCase(), { title: rpTitle, body: rpTxt, tag: 'lend-pledge-' + rpReqId, url: '/members.html' });
    } catch (pErr) { console.error('pledge notify (non-fatal):', pErr); }
    return res.status(201).json({ ok: true, quantity: rpQty });
  }
  if (req.query.action === 'loan-request-close') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rcId = parseInt((req.body || {}).request_id, 10);
    if (!Number.isFinite(rcId)) return res.status(400).json({ error: 'request_id required' });
    const rcRows = await sql`SELECT id, LOWER(requested_by_email) AS em FROM lending_requests WHERE id = ${rcId}`;
    if (!rcRows.length) return res.status(404).json({ error: 'Request not found.' });
    if (rcRows[0].em !== email && !coordAllowed && !isSuperUser(email)) {
      return res.status(403).json({ error: 'Only the requester (or the Supply Coordinator) can close this.' });
    }
    await sql`UPDATE lending_requests SET status = 'closed' WHERE id = ${rcId}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = parseInt(req.query.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });
  const body = req.body || {};

  if (req.query.action === 'loan-request') {
    const items = await sql`SELECT * FROM supply_closet WHERE id = ${id}`;
    if (items.length === 0) return res.status(404).json({ error: 'Item not found' });
    const item = items[0];
    if (item.category !== 'member_lending') return res.status(400).json({ error: 'Not a Lending Library item' });
    if (item.donated_at) return res.status(400).json({ error: 'This item has already been given away.' });
    const ownerEmail = String(item.held_by_email || '').toLowerCase();
    if (ownerEmail && ownerEmail === email) return res.status(400).json({ error: 'That’s your own item.' });

    const kind = item.offer_type === 'donate' ? 'donate' : 'borrow';
    let purpose = String(body.purpose || 'personal');
    if (VALID_LOAN_PURPOSES.indexOf(purpose) === -1) purpose = 'personal';
    const purpose_note = String(body.purpose_note || '').trim().slice(0, 300);
    const session_id = parseInt(body.session_id, 10) || null;
    const start_date = String(body.start_date || '').slice(0, 10) || null;
    const end_date = String(body.end_date || '').slice(0, 10) || null;
    if (kind === 'borrow') {
      if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end dates are required.' });
      if (end_date < start_date) return res.status(400).json({ error: 'End date is before the start date.' });
    }

    // One open ask per member per item.
    const dup = await sql`
      SELECT id FROM supply_loans
      WHERE item_id = ${id} AND LOWER(borrower_email) = ${email} AND status = 'requested'
    `;
    if (dup.length > 0) return res.status(409).json({ error: 'You already have a pending request for this item.' });

    // No double-booking against approved/out loans (borrows only).
    if (kind === 'borrow') {
      const clash = await sql`
        SELECT id, start_date, end_date, borrower_name FROM supply_loans
        WHERE item_id = ${id} AND status IN ('approved', 'handed_off')
          AND start_date IS NOT NULL AND end_date IS NOT NULL
          AND NOT (end_date < ${start_date} OR start_date > ${end_date})
      `;
      if (clash.length > 0) {
        return res.status(409).json({
          error: 'Already booked for those dates (' + fmtLoanDates(clash[0]) + ', ' + clash[0].borrower_name + '). Pick different dates.',
          conflict: clash[0]
        });
      }
    }

    const borrower_name = String(body.borrower_name || '').trim().slice(0, 200) || user.name || email;
    const inserted = await sql`
      INSERT INTO supply_loans (item_id, owner_email, owner_name, borrower_email, borrower_name,
                                kind, purpose, purpose_note, session_id, start_date, end_date)
      VALUES (${id}, ${ownerEmail}, ${item.held_by || ''}, ${email}, ${borrower_name},
              ${kind}, ${purpose}, ${purpose_note}, ${session_id}, ${start_date}, ${end_date})
      RETURNING *
    `;
    const loan = inserted[0];
    const what = kind === 'donate' ? 'would like to have' : 'would like to borrow';
    const when = loan.start_date ? ' (' + fmtLoanDates(loan) + ')' : '';
    const why = purpose === 'class' ? ' for a class' : purpose === 'event' ? ' for a co-op event' : '';
    await notifyMember(sql, ownerEmail,
      'Lending request: ' + item.item_name,
      borrower_name + ' ' + what + ' your ' + item.item_name + why + when + '. Approve or decline on My Workspace.',
      'lending_request',
      'lending:' + loan.id);
    return res.status(201).json({ loan: loan });
  }

  if (req.query.action === 'loan-respond') {
    const rows = await sql`
      SELECT l.*, c.item_name FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE l.id = ${id}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const loan = rows[0];
    if (String(loan.owner_email).toLowerCase() !== email && !coordAllowed) {
      return res.status(403).json({ error: 'Only the item’s owner can respond to this request.' });
    }
    if (loan.status !== 'requested') return res.status(400).json({ error: 'This request was already ' + loan.status + '.' });

    const approve = !!body.approve;
    const note = String(body.note || '').trim().slice(0, 300);
    if (approve && loan.kind === 'borrow' && loan.start_date && loan.end_date) {
      const clash = await sql`
        SELECT id, start_date, end_date, borrower_name FROM supply_loans
        WHERE item_id = ${loan.item_id} AND id <> ${id} AND status IN ('approved', 'handed_off')
          AND start_date IS NOT NULL AND end_date IS NOT NULL
          AND NOT (end_date < ${loan.start_date} OR start_date > ${loan.end_date})
      `;
      if (clash.length > 0) {
        return res.status(409).json({
          error: 'Those dates now clash with an approved loan to ' + clash[0].borrower_name + ' (' + fmtLoanDates(clash[0]) + ').',
          conflict: clash[0]
        });
      }
    }
    const status = approve ? 'approved' : 'declined';
    const updated = await sql`
      UPDATE supply_loans
      SET status = ${status}, decline_note = ${approve ? '' : note}, responded_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    const when = loan.start_date ? ' for ' + fmtLoanDates(loan) : '';
    if (approve) {
      await notifyMember(sql, loan.borrower_email,
        'Approved: ' + loan.item_name,
        loan.owner_name + ' approved your request' + when + '. Arrange the hand-off at co-op.',
        'lending_approved');
    } else {
      await notifyMember(sql, loan.borrower_email,
        'Not this time: ' + loan.item_name,
        loan.owner_name + ' declined your request' + (note ? ' — “' + note + '”' : '') + '.',
        'lending_declined');
    }
    return res.status(200).json({ loan: updated[0] });
  }

  if (req.query.action === 'loan-status') {
    const rows = await sql`
      SELECT l.*, c.item_name FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE l.id = ${id}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Loan not found' });
    const loan = rows[0];
    const isOwner = String(loan.owner_email).toLowerCase() === email;
    const isBorrower = String(loan.borrower_email).toLowerCase() === email;
    if (!isOwner && !isBorrower && !coordAllowed) {
      return res.status(403).json({ error: 'Not your loan.' });
    }

    const next = String(body.status || '');
    const allowedFrom = {
      canceled: ['requested', 'approved'],
      handed_off: ['approved'],
      returned: ['approved', 'handed_off']
    };
    if (!allowedFrom[next]) return res.status(400).json({ error: 'Invalid status' });
    if (allowedFrom[next].indexOf(loan.status) === -1) {
      return res.status(400).json({ error: 'Can’t mark a ' + loan.status + ' loan as ' + next + '.' });
    }

    const updated = await sql`
      UPDATE supply_loans
      SET status = ${next},
          handed_off_at = CASE WHEN ${next} = 'handed_off' THEN NOW() ELSE handed_off_at END,
          returned_at   = CASE WHEN ${next} = 'returned'   THEN NOW() ELSE returned_at END,
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    // A handed-off donation is gone from the library for good.
    if (next === 'handed_off' && loan.kind === 'donate') {
      await sql`
        UPDATE supply_closet SET donated_at = NOW(), donated_to = ${loan.borrower_name}, updated_at = NOW()
        WHERE id = ${loan.item_id}
      `;
    }

    // Tell the party who DIDN'T tap the button.
    const otherEmail = isBorrower ? loan.owner_email : loan.borrower_email;
    const actorName = isBorrower ? loan.borrower_name : loan.owner_name;
    const msg = {
      canceled: actorName + ' canceled the ' + (loan.kind === 'donate' ? 'claim' : 'loan') + ' of ' + loan.item_name + '.',
      handed_off: loan.item_name + ' marked as handed off by ' + actorName + '.',
      returned: loan.item_name + ' marked as returned by ' + actorName + '. All done!'
    }[next];
    await notifyMember(sql, otherEmail, 'Lending update: ' + loan.item_name, msg, 'lending_' + next);
    return res.status(200).json({ loan: updated[0] });
  }

  return res.status(400).json({ error: 'Unknown action' });
}

// Daily reminders (vercel.json cron → /api/supply-closet?cron=loan-reminders).
// The day before a borrow starts, both sides get a packing-list nudge; the
// day before it ends, a return nudge; after the end date, a weekly overdue
// nudge until someone marks it returned. Dedupe flags live on the loan row.
// "Today" is Indianapolis-local (feedback: server UTC dates bit us twice).
async function handleLoanRemindersCron(req, res) {
  const ua = String(req.headers['user-agent'] || '');
  const isVercelCron = ua.indexOf('vercel-cron') !== -1;
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = String(req.headers['authorization'] || '');
  const hasSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const indyDate = (offsetDays) =>
    new Date(Date.now() + offsetDays * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'America/Indianapolis' });
  const today = indyDate(0);
  const tomorrow = indyDate(1);
  const weekAgo = indyDate(-7);

  try {
    const sql = getSql();
    let packs = 0, returns = 0, overdues = 0;

    const packLoans = await sql`
      SELECT l.*, c.item_name FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE l.kind = 'borrow' AND l.status = 'approved'
        AND l.start_date = ${tomorrow} AND l.pack_reminder_sent = FALSE
    `;
    for (const l of packLoans) {
      await notifyMember(sql, l.owner_email,
        'Packing list: ' + l.item_name,
        'Bring your ' + l.item_name + ' for ' + l.borrower_name + ' tomorrow (borrowed ' + fmtLoanDates(l) + ').',
        'lending_pack');
      await notifyMember(sql, l.borrower_email,
        'Pick up tomorrow: ' + l.item_name,
        'You’re borrowing ' + l.item_name + ' from ' + l.owner_name + ' starting tomorrow (' + fmtLoanDates(l) + ').',
        'lending_pack');
      await sql`UPDATE supply_loans SET pack_reminder_sent = TRUE, updated_at = NOW() WHERE id = ${l.id}`;
      packs++;
    }

    const returnLoans = await sql`
      SELECT l.*, c.item_name FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE l.kind = 'borrow' AND l.status IN ('approved', 'handed_off')
        AND l.end_date = ${tomorrow} AND l.return_reminder_sent = FALSE
    `;
    for (const l of returnLoans) {
      await notifyMember(sql, l.borrower_email,
        'Return tomorrow: ' + l.item_name,
        'Pack up ' + l.item_name + ' to return to ' + l.owner_name + ' tomorrow. Mark it returned on My Workspace once it’s back.',
        'lending_return');
      await notifyMember(sql, l.owner_email,
        'Coming back tomorrow: ' + l.item_name,
        l.borrower_name + ' is due to return your ' + l.item_name + ' tomorrow.',
        'lending_return');
      await sql`UPDATE supply_loans SET return_reminder_sent = TRUE, updated_at = NOW() WHERE id = ${l.id}`;
      returns++;
    }

    const overdueLoans = await sql`
      SELECT l.*, c.item_name FROM supply_loans l
      JOIN supply_closet c ON c.id = l.item_id
      WHERE l.kind = 'borrow' AND l.status IN ('approved', 'handed_off')
        AND l.end_date < ${today}
        AND (l.overdue_last_sent IS NULL OR l.overdue_last_sent <= ${weekAgo})
    `;
    for (const l of overdueLoans) {
      await notifyMember(sql, l.borrower_email,
        'Still out: ' + l.item_name,
        l.owner_name + '’s ' + l.item_name + ' was due back ' + fmtLoanDates({ start_date: l.end_date }) + '. Please return it and mark it returned on My Workspace.',
        'lending_overdue');
      await notifyMember(sql, l.owner_email,
        'Not back yet: ' + l.item_name,
        'Your ' + l.item_name + ' (lent to ' + l.borrower_name + ') was due back ' + fmtLoanDates({ start_date: l.end_date }) + '.',
        'lending_overdue');
      await sql`UPDATE supply_loans SET overdue_last_sent = ${today}, updated_at = NOW() WHERE id = ${l.id}`;
      overdues++;
    }

    return res.status(200).json({ ok: true, packs, returns, overdues, today });
  } catch (err) {
    console.error('Loan reminders cron error:', err);
    return res.status(500).json({ error: 'Cron error' });
  }
}

// ══════════════════════════════════════════════════════════════════
// Merch Desk Phase 1 (#351, 2026-08-14)
// ══════════════════════════════════════════════════════════════════
// DB-driven merch ledger replacing the manager's personal-Venmo +
// hand-tracked flow at special events. Catalog (merch_items /
// merch_variants), member pickup orders (merch_desk_orders /
// merch_desk_order_items) with allocated/backordered inventory truth
// (math in api/_merch.js), payment recording (cash/check/venmo/paypal —
// no online payment in Phase 1), and an event quick-sale that records a
// delivered+paid order in one step.
//
// Gates:
//   - Members: merch-catalog / merch-my-orders / merch-place-order.
//     Orders are keyed to the ACTING identity's family_email (resolved
//     server-side via _family.resolveFamily — never trusted from the
//     client), so members only ever read their own orders.
//   - Manager: everything else. Same capability the legacy merch report
//     uses ('merch_manage' → Communications Director + Merchandise
//     Manager by default, editable in the Permissions admin), plus any
//     board member and the super users.

// Methods accepted for NEW payments (Erin, 2026-08-14: the manager's
// personal Venmo is retired — financial tracking got hairy). 'venmo'
// stays valid in the schema CHECK so historical rows keep rendering;
// it just can't be recorded on anything new.
const MERCH_PAYMENT_METHODS = ['cash', 'check', 'paypal'];

// merch_desk_orders.source = where an order came from: 'portal' (member
// Shop), 'event' (Quick Sale), 'web' (public homepage form, api/tour.js).
// The manager's Orders tab shows web + portal as "Web" (ordered ahead)
// and event as "Event" (Erin, 2026-08-15). Rows from before the column
// existed are back-filled by migrate.sql.

// Free-text fields the manager types (vendor, notes): trim, drop any
// markup, cap the length. Escaping still happens at every render sink —
// this just keeps junk out of the ledger.
function merchCleanText(v, max) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

// Variant fields as merch-variant-save validates them (label / price /
// on_order / restock_threshold / active / sort_order / notes) — shared
// with the first_variant riding a new item in merch-item-save. Returns
// { error } or the cleaned fields. on_hand is deliberately not here.
function merchVariantFields(src) {
  const label = String(src.label || '').trim().slice(0, 200);
  const priceCents = parseInt(src.price_cents, 10);
  if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 10000000) {
    return { error: 'Price must be between $0 and $100,000.' };
  }
  return {
    label,
    priceCents,
    onOrder: Math.max(0, Math.min(parseInt(src.on_order, 10) || 0, 100000)),
    restockThreshold: Math.max(0, Math.min(parseInt(src.restock_threshold, 10) || 0, 100000)),
    active: src.active === undefined ? true : !!src.active,
    sortOrder: Math.max(0, Math.min(parseInt(src.sort_order, 10) || 0, 10000)),
    notes: merchCleanText(src.notes, 1000)
  };
}

async function canManageMerchDesk(email) {
  if (!email) return false;
  if (isSuperUser(email)) return true;
  if (await hasCapability(email, 'merch_manage')) return true;
  return await isBoardMember(email);
}

// The family this login acts for. Falls back to the login itself so a
// board mailbox (no family profile) can still test-order on dev.
async function merchFamilyEmailFor(sql, email) {
  try {
    const fam = await resolveFamily(sql, email);
    if (fam && fam.family_email) return String(fam.family_email).toLowerCase();
  } catch (e) {
    console.error('merch resolveFamily failed (non-fatal):', e);
  }
  return String(email || '').toLowerCase();
}

// Lines normalization lives in api/_merch.js (normalizeLines) — pure,
// shared with the public homepage order form in api/tour.js, and
// guarded by scripts/test-merch-allocation.js.
const merchNormalizeLines = normalizeLines;

// Load + validate the variants a lines payload references. Returns
// { error } or { variants: { [id]: row } }.
async function merchLoadVariants(sql, lines, requireActive) {
  const vids = lines.map(l => l.variant_id);
  const rows = await sql`
    SELECT v.id, v.item_id, v.label, v.price_cents, v.on_hand, v.active,
           i.name AS item_name, i.active AS item_active, i.preorder_only AS item_preorder_only
    FROM merch_variants v
    JOIN merch_items i ON i.id = v.item_id
    WHERE v.id = ANY(${vids})
  `;
  const byId = {};
  rows.forEach(r => { byId[r.id] = r; });
  for (const l of lines) {
    const v = byId[l.variant_id];
    if (!v) return { error: 'One of those items no longer exists — refresh and try again.' };
    // Members (and the public form) may only buy active, PRICED variants —
    // price_cents = 0 means the manager hasn't set a price yet (e.g. the
    // inventory carry-over seed). Quick Sale (requireActive false) is the
    // manager's own hands, so it stays exempt.
    if (requireActive && (!v.active || !v.item_active || !(v.price_cents > 0))) {
      return { error: (v.item_name + (v.label ? ' (' + v.label + ')' : '')) + ' isn’t available right now — refresh and try again.' };
    }
  }
  return { variants: byId };
}

// Order lines with item/variant labels, grouped by order id.
async function merchLinesByOrder(sql, orderIds) {
  if (!orderIds.length) return {};
  const rows = await sql`
    SELECT oi.id, oi.order_id, oi.variant_id, oi.qty, oi.price_cents_each, oi.stock_status,
           v.label AS variant_label, i.name AS item_name
    FROM merch_desk_order_items oi
    JOIN merch_variants v ON v.id = oi.variant_id
    JOIN merch_items i ON i.id = v.item_id
    WHERE oi.order_id = ANY(${orderIds})
    ORDER BY oi.id
  `;
  const byOrder = {};
  rows.forEach(r => { (byOrder[r.order_id] || (byOrder[r.order_id] = [])).push(r); });
  return byOrder;
}

// Display name for the acting member (people row first, Google name as
// fallback) — mirrors the loan-request-add lookup.
async function merchBuyerNameFor(sql, email, googleName) {
  try {
    const p = await sql`SELECT first_name, last_name FROM people
      WHERE LOWER(email) = ${email} OR LOWER(personal_email) = ${email} LIMIT 1`;
    if (p.length) {
      const n = ((p[0].first_name || '') + ' ' + (p[0].last_name || '')).trim();
      if (n) return n;
    }
  } catch (_) { /* fall through */ }
  return googleName || email;
}

// Convert an order's backordered lines to allocated for whatever the
// shelf covers NOW — runs when the manager marks ready/delivered, i.e.
// the moment the physical items are actually set aside/handed over.
// Truthful (2026-08-15 review finding 4): units the shelf can't cover
// stay 'backordered' on the order rather than being recorded as taken —
// so a later cancel can only restore what really left the shelf, and
// the shortfall keeps showing on Needs ordering until stock arrives or
// the manager recounts (merch-stock-adjust). Returns units allocated.
async function merchConsumeBackorders(sql, orderId) {
  const back = await sql`
    SELECT id, variant_id, qty, price_cents_each FROM merch_desk_order_items
    WHERE order_id = ${orderId} AND stock_status = 'backordered'
    ORDER BY id
  `;
  return allocateBackorderedLines(sql, orderId, back);
}

async function handleMerchDeskActions(req, res, sql, user, actingEmail) {
  const email = String(actingEmail).toLowerCase();
  const action = String(req.query.action || '');
  const body = req.body || {};

  // ── Member: browse the catalog ──
  if (action === 'merch-catalog') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const items = await sql`
      SELECT id, name, description, image_url, sort_order, preorder_only
      FROM merch_items WHERE active = TRUE
      ORDER BY sort_order, name
    `;
    const variants = await sql`
      SELECT v.id, v.item_id, v.label, v.price_cents, v.on_hand, v.sort_order
      FROM merch_variants v
      JOIN merch_items i ON i.id = v.item_id
      WHERE v.active = TRUE AND i.active = TRUE AND v.price_cents > 0
      ORDER BY v.item_id, v.sort_order, v.label
    `;
    return res.status(200).json({ items, variants });
  }

  // ── Member: my family's orders ──
  if (action === 'merch-my-orders') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const famEmail = await merchFamilyEmailFor(sql, email);
    // Screened (spam-flagged) web orders stay out of the family's view —
    // they surface only in the manager's screened bucket until un-screened
    // (the family's Heads-up card reads this list, 2026-08-15).
    const orders = await sql`
      SELECT id, family_email, buyer_name, status, payment_method, paid_at,
             total_cents, fee_cents, note, created_at
      FROM merch_desk_orders
      WHERE LOWER(family_email) = ${famEmail} AND screen_reason = ''
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const linesByOrder = await merchLinesByOrder(sql, orders.map(o => o.id));
    return res.status(200).json({
      orders: orders.map(o => Object.assign({}, o, { lines: linesByOrder[o.id] || [] })),
      family_email: famEmail
    });
  }

  // ── Member: place a pickup order ──
  if (action === 'merch-place-order') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const lines = merchNormalizeLines(body.lines);
    if (!lines) return res.status(400).json({ error: 'Pick at least one item.' });
    const note = String(body.note || '').trim().slice(0, 500);
    const loaded = await merchLoadVariants(sql, lines, true);
    if (loaded.error) return res.status(409).json({ error: loaded.error });

    const priced = lines.map(l => {
      const v = loaded.variants[l.variant_id];
      return { variant_id: l.variant_id, qty: l.qty, price_cents_each: v.price_cents };
    });
    const totalCents = orderTotalCents(priced);

    const famEmail = await merchFamilyEmailFor(sql, email);
    const buyerName = await merchBuyerNameFor(sql, email, user.name);
    const ins = await sql`
      INSERT INTO merch_desk_orders (family_email, buyer_name, status, total_cents, note, created_by_email, source)
      VALUES (${famEmail}, ${buyerName}, 'pending_payment', ${totalCents}, ${note}, ${email}, 'portal')
      RETURNING id, family_email, buyer_name, status, payment_method, paid_at, total_cents, note, created_at, source
    `;
    const order = ins[0];
    // Truthful allocation (api/_merch.js): each line takes what the shelf
    // has RIGHT NOW via an atomic conditional decrement — the on_hand the
    // catalog showed the member may be stale, and two families can race
    // for the last one. Units not actually removed land as 'backordered'.
    const written = await allocateOrderLines(sql, order.id, priced);

    // Heads-up for the manager (best-effort, never blocks the order).
    try {
      const mgr = await getRoleHolderEmail('Merchandise Manager');
      if (mgr) {
        await notifyMember(sql, String(mgr).toLowerCase(),
          'New merch order from ' + buyerName,
          written.reduce((n, l) => n + l.qty, 0) + ' item(s), pay at pickup. Open the Merchandise report to review.',
          'merch_order');
      }
    } catch (nErr) { console.error('merch order notify (non-fatal):', nErr); }

    const linesByOrder = await merchLinesByOrder(sql, [order.id]);
    touchTodos(sql, ['merch-open', 'merch-restock']); // #368
    return res.status(201).json({ order: Object.assign({}, order, { lines: linesByOrder[order.id] || [] }) });
  }

  // ── Everything below is manager-only ──
  if (!(await canManageMerchDesk(email))) {
    return res.status(403).json({
      error: 'Only the Merchandise Manager (or a board member) can do that.',
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }

  // Full catalog (inactive rows included) + open backorder demand.
  if (action === 'merch-admin-catalog') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const items = await sql`
      SELECT id, name, description, image_url, active, sort_order, updated_at, updated_by,
             vendor_name, vendor_url, notes, preorder_only
      FROM merch_items ORDER BY sort_order, name
    `;
    const variants = await sql`
      SELECT id, item_id, label, price_cents, on_hand, on_order, restock_threshold,
             active, sort_order, updated_at, updated_by, notes
      FROM merch_variants ORDER BY item_id, sort_order, label
    `;
    // Open backordered demand per variant. Screened (spam-flagged) public
    // orders are saved all-backordered and must NOT count as demand — the
    // shelf owes them nothing until the manager un-screens (2026-08-15
    // review finding 1; same filter in merch-todo-counts + merch-needs-ordering).
    const demand = await sql`
      SELECT oi.variant_id, SUM(oi.qty)::int AS backordered
      FROM merch_desk_order_items oi
      JOIN merch_desk_orders o ON o.id = oi.order_id
      WHERE oi.stock_status = 'backordered'
        AND o.status NOT IN ('cancelled', 'delivered')
        AND o.screen_reason = ''
      GROUP BY oi.variant_id
    `;
    // Units already set aside for open pre-orders (allocated lines on
    // orders not yet handed over) — the shelf holds them, so the manager
    // sees "N reserved" instead of wondering where the count went after a
    // stock receipt filled backorders (Erin, 2026-08-16).
    const reserved = await sql`
      SELECT oi.variant_id, SUM(oi.qty)::int AS reserved
      FROM merch_desk_order_items oi
      JOIN merch_desk_orders o ON o.id = oi.order_id
      WHERE oi.stock_status = 'allocated'
        AND o.status NOT IN ('cancelled', 'delivered')
        AND o.screen_reason = ''
      GROUP BY oi.variant_id
    `;
    return res.status(200).json({ items, variants, backordered: demand, reserved });
  }

  if (action === 'merch-orders') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const orders = await sql`
      SELECT id, family_email, buyer_name, status, payment_method, paid_at,
             total_cents, fee_cents, note, created_at, created_by_email,
             contact_email, contact_phone, screen_reason, source
      FROM merch_desk_orders
      ORDER BY created_at DESC
      LIMIT 300
    `;
    const linesByOrder = await merchLinesByOrder(sql, orders.map(o => o.id));
    return res.status(200).json({
      orders: orders.map(o => Object.assign({}, o, { lines: linesByOrder[o.id] || [] }))
    });
  }

  // Order lifecycle: paid (with method) / unpaid / ready / unready /
  // delivered / cancel.
  if (action === 'merch-order-status') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
    const set = String(body.set || '');
    const rows = await sql`SELECT * FROM merch_desk_orders WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = rows[0];
    if (order.status === 'cancelled') return res.status(409).json({ error: 'That order was cancelled.' });

    if (set === 'paid') {
      const method = String(body.payment_method || '');
      if (MERCH_PAYMENT_METHODS.indexOf(method) === -1) {
        return res.status(400).json({ error: 'How did they pay? (cash, check, or paypal)' });
      }
      // Payment can be recorded at ANY non-cancelled stage — including a
      // delivered order that was handed over before the money was noted
      // (2026-08-15 review finding 3). Only pending_payment advances to
      // 'paid'; ready/delivered keep their status and just gain paid_at.
      // PayPal payments carry the pass-through processing fee (Erin,
      // 2026-08-16); cash/check carry none. total_cents stays the price.
      const fee = orderFeeCents(method, order.total_cents);
      const upd = await sql`
        UPDATE merch_desk_orders
        SET payment_method = ${method}, paid_at = NOW(), fee_cents = ${fee},
            status = CASE WHEN status = 'pending_payment' THEN 'paid' ELSE status END
        WHERE id = ${id}
        RETURNING *
      `;
      return res.status(200).json({ order: upd[0] });
    }

    // Undo a payment (Orders grid Payment toggle, Erin 2026-08-15): clear
    // paid_at + method. Only a 'paid' status steps back to
    // pending_payment — ready/delivered keep their fulfillment status
    // (the payment record and the hand-over are independent facts).
    if (set === 'unpaid') {
      if (!order.paid_at) return res.status(409).json({ error: 'That order isn’t marked paid.' });
      const upd = await sql`
        UPDATE merch_desk_orders
        SET payment_method = NULL, paid_at = NULL, fee_cents = 0,
            status = CASE WHEN status = 'paid' THEN 'pending_payment' ELSE status END
        WHERE id = ${id}
        RETURNING *
      `;
      return res.status(200).json({ order: upd[0] });
    }

    // Back from "Ready for pickup" to plain Pre-order (Status select). The
    // status returns to paid / pending_payment per paid_at; stock already
    // set aside for it stays allocated (nothing physical changed).
    if (set === 'unready') {
      if (order.status !== 'ready') return res.status(409).json({ error: 'That order isn’t marked ready.' });
      const back = order.paid_at ? 'paid' : 'pending_payment';
      const upd = await sql`
        UPDATE merch_desk_orders SET status = ${back} WHERE id = ${id} RETURNING *
      `;
      return res.status(200).json({ order: upd[0] });
    }

    if (set === 'ready' || set === 'delivered') {
      if (order.status === 'delivered') return res.status(409).json({ error: 'Already delivered.' });
      const consumed = await merchConsumeBackorders(sql, id);
      const upd = await sql`
        UPDATE merch_desk_orders SET status = ${set} WHERE id = ${id} RETURNING *
      `;
      if (set === 'ready' && order.family_email) {
        const owedPp = orderFeeCents('paypal', order.total_cents);
        const owedNote = order.paid_at ? '' : ' Payment (' + '$' + (order.total_cents / 100).toFixed(2) + ') is due at pickup — cash, check, or PayPal'
          + (owedPp ? ' ($' + ((order.total_cents + owedPp) / 100).toFixed(2) + ' by PayPal, which includes its processing fee)' : '') + '.';
        await notifyMember(sql, String(order.family_email).toLowerCase(),
          'Your merch order is ready',
          'Your Roots & Wings merch order is ready for pickup at the next event.' + owedNote,
          'merch_ready');
      }
      // Lines come back so the client shows what REALLY happened to stock
      // (a shortfall the shelf couldn't cover stays 'backordered').
      const linesByOrder = await merchLinesByOrder(sql, [id]);
      return res.status(200).json({
        order: Object.assign({}, upd[0], { lines: linesByOrder[id] || [] }),
        consumed
      });
    }

    if (set === 'cancel') {
      if (order.status === 'delivered') return res.status(409).json({ error: 'Delivered orders can’t be cancelled.' });
      // Flip the status FIRST with a conditional UPDATE (review 2026-08-16):
      // two overlapping cancels (double-tap at the table, two managers) both
      // passed the JS status check and restored the stock twice. Only the
      // request that wins the flip restores stock.
      const upd = await sql`
        UPDATE merch_desk_orders SET status = 'cancelled'
        WHERE id = ${id} AND status NOT IN ('cancelled', 'delivered')
        RETURNING *
      `;
      if (!upd.length) return res.status(409).json({ error: 'That order was already cancelled (or delivered).' });
      // Restore stock the order had claimed; backordered lines never took any.
      const allocated = await sql`
        SELECT variant_id, SUM(qty)::int AS qty FROM merch_desk_order_items
        WHERE order_id = ${id} AND stock_status = 'allocated'
        GROUP BY variant_id
      `;
      for (const l of allocated) {
        await sql`UPDATE merch_variants SET on_hand = on_hand + ${l.qty}, updated_at = NOW() WHERE id = ${l.variant_id}`;
      }
      return res.status(200).json({ order: upd[0], restocked: allocated.length });
    }

    return res.status(400).json({ error: 'set must be paid, unpaid, ready, unready, delivered, or cancel' });
  }

  // Edit an order's LINES (Erin, 2026-08-17: members enter orders wrong;
  // the manager fixes them here rather than cancel + re-add, which would
  // lose the order date, the family link and any notification history).
  // Desk orders only, not delivered / cancelled / screened. Truthful stock:
  // every allocated unit the order held goes back on the shelf, the old
  // lines are dropped, and the new lines are allocated fresh through
  // api/_merch.js allocateOrderLines (takes what the shelf really has —
  // the just-restored units included — the rest backordered). Unchanged
  // variants keep the price they were ordered at; new ones take today's.
  // total_cents is recomputed; a PayPal-paid order's fee_cents follows the
  // new total (the manager settles the difference by hand — noted in UI).
  if (action === 'merch-order-edit') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
    const lines = merchNormalizeLines(body.lines);
    if (!lines) return res.status(400).json({ error: 'An order needs at least one item.' });
    const rows = await sql`SELECT * FROM merch_desk_orders WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = rows[0];
    if (order.status === 'cancelled') return res.status(409).json({ error: 'That order was cancelled.' });
    if (order.status === 'delivered') return res.status(409).json({ error: 'Delivered orders can’t be edited.' });
    if (order.screen_reason) return res.status(409).json({ error: 'Rescue this order (Not spam) before editing it.' });
    // Manager's own hands: inactive/unpriced variants allowed (requireActive false), like Quick Sale.
    const loaded = await merchLoadVariants(sql, lines, false);
    if (loaded.error) return res.status(409).json({ error: loaded.error });
    const oldLines = await sql`SELECT variant_id, qty, price_cents_each, stock_status FROM merch_desk_order_items WHERE order_id = ${id}`;
    const oldPrice = {};
    oldLines.forEach(l => { if (oldPrice[l.variant_id] == null) oldPrice[l.variant_id] = l.price_cents_each; });
    // 1. Give back every allocated unit, drop the old lines.
    const give = {};
    oldLines.forEach(l => { if (l.stock_status === 'allocated') give[l.variant_id] = (give[l.variant_id] || 0) + (parseInt(l.qty, 10) || 0); });
    for (const vid of Object.keys(give)) {
      if (give[vid] > 0) await sql`UPDATE merch_variants SET on_hand = on_hand + ${give[vid]}, updated_at = NOW() WHERE id = ${parseInt(vid, 10)}`;
    }
    await sql`DELETE FROM merch_desk_order_items WHERE order_id = ${id}`;
    // 2. Allocate the new lines truthfully at the right prices.
    const priced = lines.map(l => ({
      variant_id: l.variant_id, qty: l.qty,
      price_cents_each: oldPrice[l.variant_id] != null ? oldPrice[l.variant_id] : (loaded.variants[l.variant_id].price_cents || 0)
    }));
    await allocateOrderLines(sql, id, priced);
    const total = orderTotalCents(priced);
    const fee = order.paid_at ? orderFeeCents(order.payment_method, total) : 0;
    const upd = await sql`
      UPDATE merch_desk_orders SET total_cents = ${total}, fee_cents = ${fee}
      WHERE id = ${id} RETURNING *
    `;
    const linesByOrder = await merchLinesByOrder(sql, [id]);
    return res.status(200).json({ order: Object.assign({}, upd[0], { lines: linesByOrder[id] || [] }), previous_total_cents: order.total_cents });
  }

  // "Not spam" for a screened public-form order (Orders tab bucket).
  // Clears screen_reason and — because screened orders were saved
  // all-backordered so junk could never drain the shelf — re-runs
  // allocation against CURRENT stock (api/_merch.js
  // allocateBackorderedLines, atomic per line): each backordered line
  // becomes allocated for what stock covers now, with any remainder split
  // off as a fresh backordered line. No email goes out (the buyer's
  // confirmation never sent — the manager follows up by hand, same as
  // the legacy rescue).
  if (action === 'merch-order-unscreen') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
    const rows = await sql`SELECT * FROM merch_desk_orders WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = rows[0];
    if (order.status === 'cancelled') return res.status(409).json({ error: 'That order was cancelled.' });
    if (!order.screen_reason) return res.status(409).json({ error: 'That order isn’t screened.' });

    const reallocated = await merchConsumeBackorders(sql, id);
    const upd = await sql`
      UPDATE merch_desk_orders SET screen_reason = '' WHERE id = ${id} RETURNING *
    `;
    const linesByOrder = await merchLinesByOrder(sql, [id]);
    return res.status(200).json({
      order: Object.assign({}, upd[0], { lines: linesByOrder[id] || [] }),
      reallocated
    });
  }

  // Cheap counts for the Merchandise Manager's To Do card: variants
  // that need ordering (open backorders or below the restock threshold)
  // + open orders waiting on the manager (Desk queue + legacy web-form
  // rows not yet delivered), both excluding screened rows.
  if (action === 'merch-todo-counts') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const needs = await sql`
      SELECT COUNT(*)::int AS n
      FROM merch_variants v
      LEFT JOIN (
        SELECT oi.variant_id, SUM(oi.qty)::int AS backordered
        FROM merch_desk_order_items oi
        JOIN merch_desk_orders o ON o.id = oi.order_id
        WHERE oi.stock_status = 'backordered'
          AND o.status NOT IN ('cancelled', 'delivered')
          AND o.screen_reason = ''
        GROUP BY oi.variant_id
      ) b ON b.variant_id = v.id
      WHERE v.active = TRUE
        AND (COALESCE(b.backordered, 0) > 0 OR v.on_hand < v.restock_threshold)
    `;
    const deskOpen = await sql`
      SELECT COUNT(*)::int AS n FROM merch_desk_orders
      WHERE status IN ('pending_payment', 'paid', 'ready') AND screen_reason = ''
    `;
    let legacyOpen = 0;
    try {
      const lo = await sql`
        SELECT COUNT(*)::int AS n FROM merch_orders
        WHERE delivered_at IS NULL AND screen_reason = ''
      `;
      legacyOpen = (lo[0] && lo[0].n) || 0;
    } catch (legacyErr) {
      console.error('merch-todo-counts legacy count (non-fatal):', legacyErr);
    }
    return res.status(200).json({
      needs: (needs[0] && needs[0].n) || 0,
      open: ((deskOpen[0] && deskOpen[0].n) || 0) + legacyOpen
    });
  }

  // Catalog item upsert.
  if (action === 'merch-item-save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const name = String(body.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'An item name is required.' });
    const description = String(body.description || '').trim().slice(0, 1000);
    const imageUrl = String(body.image_url || '').trim().slice(0, 500);
    const active = body.active === undefined ? true : !!body.active;
    const sortOrder = Math.max(0, Math.min(parseInt(body.sort_order, 10) || 0, 10000));
    // Vendor + notes carried over from the retired Inventory tab (Erin,
    // 2026-08-15); preorder_only = printed to order (tees) — Quick Sale
    // records these as pre-orders, and the Shop/public form say so.
    const vendorName = merchCleanText(body.vendor_name, 200);
    const vendorUrl = merchCleanText(body.vendor_url, 500);
    const notes = merchCleanText(body.notes, 1000);
    const preorderOnly = !!body.preorder_only;
    const id = body.id != null ? parseInt(body.id, 10) : null;
    // Optional first variant riding a NEW item (the "+ Add item" form takes
    // price / on hand / reorder-at inline so the manager isn't forced into
    // a second step — Erin 2026-08-15). Validated up front, exactly like
    // merch-variant-save, so a bad price rejects BEFORE the item row is
    // written. Ignored on edits (variants edit on their own rows).
    const fv = (body.first_variant && typeof body.first_variant === 'object' && !Array.isArray(body.first_variant))
      ? body.first_variant : null;
    let firstVariant = null;
    if (fv && !(Number.isInteger(id) && id > 0)) {
      firstVariant = merchVariantFields(fv);
      if (firstVariant.error) return res.status(400).json({ error: firstVariant.error });
      // Starting count for a brand-new variant — the one place on_hand is
      // set directly (there is no stock history yet to keep truthful).
      firstVariant.on_hand = Math.max(0, Math.min(parseInt(fv.on_hand, 10) || 0, 100000));
    }
    let row;
    if (Number.isInteger(id) && id > 0) {
      const upd = await sql`
        UPDATE merch_items
        SET name = ${name}, description = ${description}, image_url = ${imageUrl},
            active = ${active}, sort_order = ${sortOrder},
            vendor_name = ${vendorName}, vendor_url = ${vendorUrl}, notes = ${notes},
            preorder_only = ${preorderOnly},
            updated_at = NOW(), updated_by = ${email}
        WHERE id = ${id} RETURNING *
      `;
      if (!upd.length) return res.status(404).json({ error: 'Item not found.' });
      row = upd[0];
    } else {
      const ins = await sql`
        INSERT INTO merch_items (name, description, image_url, active, sort_order,
                                 vendor_name, vendor_url, notes, preorder_only, updated_by)
        VALUES (${name}, ${description}, ${imageUrl}, ${active}, ${sortOrder},
                ${vendorName}, ${vendorUrl}, ${notes}, ${preorderOnly}, ${email})
        RETURNING *
      `;
      row = ins[0];
    }
    let variantRow = null;
    if (firstVariant) {
      const v = firstVariant;
      const vins = await sql`
        INSERT INTO merch_variants (item_id, label, price_cents, on_hand, on_order, restock_threshold, active, sort_order, notes, updated_by)
        VALUES (${row.id}, ${v.label}, ${v.priceCents}, ${v.on_hand}, ${v.onOrder}, ${v.restockThreshold}, ${v.active}, ${v.sortOrder}, ${v.notes}, ${email})
        RETURNING *
      `;
      variantRow = vins[0];
    }
    return res.status(200).json({ item: row, variant: variantRow });
  }

  // Variant upsert. on_hand deliberately NOT settable here — stock truth
  // moves only through orders and merch-stock-adjust.
  if (action === 'merch-variant-save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const itemId = parseInt(body.item_id, 10);
    const f = merchVariantFields(body);
    if (f.error) return res.status(400).json({ error: f.error });
    const label = f.label, priceCents = f.priceCents, onOrder = f.onOrder,
      restockThreshold = f.restockThreshold, active = f.active, sortOrder = f.sortOrder, notes = f.notes;
    const id = body.id != null ? parseInt(body.id, 10) : null;
    let row;
    if (Number.isInteger(id) && id > 0) {
      const upd = await sql`
        UPDATE merch_variants
        SET label = ${label}, price_cents = ${priceCents}, on_order = ${onOrder},
            restock_threshold = ${restockThreshold}, active = ${active},
            sort_order = ${sortOrder}, notes = ${notes}, updated_at = NOW(), updated_by = ${email}
        WHERE id = ${id} RETURNING *
      `;
      if (!upd.length) return res.status(404).json({ error: 'Variant not found.' });
      row = upd[0];
    } else {
      if (!Number.isInteger(itemId) || itemId < 1) return res.status(400).json({ error: 'item_id required' });
      const item = await sql`SELECT id FROM merch_items WHERE id = ${itemId}`;
      if (!item.length) return res.status(404).json({ error: 'Item not found.' });
      const ins = await sql`
        INSERT INTO merch_variants (item_id, label, price_cents, on_order, restock_threshold, active, sort_order, notes, updated_by)
        VALUES (${itemId}, ${label}, ${priceCents}, ${onOrder}, ${restockThreshold}, ${active}, ${sortOrder}, ${notes}, ${email})
        RETURNING *
      `;
      row = ins[0];
    }
    return res.status(200).json({ variant: row });
  }

  // Stock adjustment — shipment received (+N, optionally drawing down
  // on_order) or a recount correction (±N). on_hand never goes negative.
  if (action === 'merch-stock-adjust') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const variantId = parseInt(body.variant_id, 10);
    if (!Number.isInteger(variantId) || variantId < 1) return res.status(400).json({ error: 'variant_id required' });
    // Two modes (review 2026-08-16): `set_on_hand` = the ABSOLUTE count the
    // manager just typed (the Catalog's inline recount — a delta computed
    // from a stale tab lands on the wrong number), or `delta` = a relative
    // receipt/correction. Either way the fill-backorders pass below runs
    // when stock went UP.
    let delta = parseInt(body.delta, 10);
    const setOnHand = body.set_on_hand != null ? parseInt(body.set_on_hand, 10) : null;
    if (setOnHand != null) {
      if (!Number.isFinite(setOnHand) || setOnHand < 0 || setOnHand > 100000) return res.status(400).json({ error: 'set_on_hand must be 0–100000.' });
      const cur = await sql`SELECT on_hand FROM merch_variants WHERE id = ${variantId}`;
      if (!cur.length) return res.status(404).json({ error: 'Variant not found.' });
      delta = setOnHand - (parseInt(cur[0].on_hand, 10) || 0);
      if (delta === 0) return res.status(200).json({ variant: (await sql`SELECT * FROM merch_variants WHERE id = ${variantId}`)[0], filled: 0, filled_orders: [] });
    } else if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000) {
      return res.status(400).json({ error: 'delta must be a non-zero adjustment.' });
    }
    const fromOnOrder = !!body.from_on_order && delta > 0;
    const upd = fromOnOrder
      ? await sql`
          UPDATE merch_variants
          SET on_hand = GREATEST(on_hand + ${delta}, 0),
              on_order = GREATEST(on_order - ${delta}, 0),
              updated_at = NOW(), updated_by = ${email}
          WHERE id = ${variantId} RETURNING *`
      : await sql`
          UPDATE merch_variants
          SET on_hand = GREATEST(on_hand + ${delta}, 0),
              updated_at = NOW(), updated_by = ${email}
          WHERE id = ${variantId} RETURNING *`;
    if (!upd.length) return res.status(404).json({ error: 'Variant not found.' });
    // Stock came IN → fill this variant's open backorders, oldest order
    // first (Erin, 2026-08-16: "when I update the On Hand, the backordered
    // pill doesn't disappear"). Same truthful path as ready/un-screen
    // (api/_merch.js allocateBackorderedLines): a line flips to allocated
    // only for units the shelf really gave up. Screened spam orders are
    // never filled. Returns what was set aside so the client can say so.
    let filled = 0;
    const filledOrders = [];
    if (delta > 0 && upd[0].on_hand > 0) {
      const back = await sql`
        SELECT oi.id, oi.order_id, oi.variant_id, oi.qty, oi.price_cents_each
        FROM merch_desk_order_items oi
        JOIN merch_desk_orders o ON o.id = oi.order_id
        WHERE oi.variant_id = ${variantId} AND oi.stock_status = 'backordered'
          AND o.status NOT IN ('cancelled', 'delivered') AND o.screen_reason = ''
        ORDER BY o.created_at ASC, oi.id ASC
      `;
      for (const l of back) {
        const got = await allocateBackorderedLines(sql, l.order_id, [l]);
        if (got > 0) { filled += got; if (filledOrders.indexOf(l.order_id) === -1) filledOrders.push(l.order_id); }
        else break; // shelf is empty again — the rest stay backordered
      }
    }
    const fresh = filled ? await sql`SELECT * FROM merch_variants WHERE id = ${variantId}` : upd;
    return res.status(200).json({ variant: fresh[0], filled, filled_orders: filledOrders });
  }

  // Needs-ordering report: open backordered demand + below-threshold
  // variants, with a suggested supplier order quantity.
  if (action === 'merch-needs-ordering') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const rows = await sql`
      SELECT v.id, v.label, v.on_hand, v.on_order, v.restock_threshold,
             i.name AS item_name,
             COALESCE(b.backordered, 0)::int AS backordered
      FROM merch_variants v
      JOIN merch_items i ON i.id = v.item_id
      LEFT JOIN (
        SELECT oi.variant_id, SUM(oi.qty)::int AS backordered
        FROM merch_desk_order_items oi
        JOIN merch_desk_orders o ON o.id = oi.order_id
        WHERE oi.stock_status = 'backordered'
          AND o.status NOT IN ('cancelled', 'delivered')
          AND o.screen_reason = ''
        GROUP BY oi.variant_id
      ) b ON b.variant_id = v.id
      WHERE v.active = TRUE
        AND (COALESCE(b.backordered, 0) > 0 OR v.on_hand < v.restock_threshold)
      ORDER BY i.name, v.sort_order, v.label
    `;
    return res.status(200).json({
      rows: rows.map(r => Object.assign({}, r, { suggested: needsOrderingQty(r, r.backordered) }))
    });
  }

  // Event quick-sale: items + qty, member family OR guest name, payment
  // method — records a delivered + paid order in one step and decrements
  // stock (clamped at 0: the items physically left the table, whatever
  // the count said).
  if (action === 'merch-quick-sale') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const lines = merchNormalizeLines(body.lines);
    if (!lines) return res.status(400).json({ error: 'Tap at least one item.' });
    const method = String(body.payment_method || '');
    if (MERCH_PAYMENT_METHODS.indexOf(method) === -1) {
      return res.status(400).json({ error: 'Pick how they paid (cash, check, or paypal).' });
    }
    let famEmail = String(body.family_email || '').trim().toLowerCase().slice(0, 200) || null;
    if (famEmail && famEmail.indexOf('@') === -1) famEmail = null;
    const buyerName = String(body.buyer_name || '').trim().slice(0, 200);
    if (!famEmail && !buyerName) {
      return res.status(400).json({ error: 'Pick the member family, or type a guest name.' });
    }
    const note = String(body.note || '').trim().slice(0, 500);
    const loaded = await merchLoadVariants(sql, lines, false);
    if (loaded.error) return res.status(409).json({ error: loaded.error });

    // Printed-to-order items (merch_items.preorder_only — tees) can't be
    // handed over at the table (Erin, 2026-08-15), and neither can an
    // item the shelf shows NONE of (on_hand 0 — Erin, 2026-08-16: the
    // buyer is ordering it, not walking off with it): those lines become
    // a separate PRE-ORDER (paid now, allocated/backordered against
    // stock, NOT delivered) so the queue still shows a pickup owed and
    // the To Do / Heads-up counts pick it up. Everything else is the
    // instant, delivered + paid sale it always was. A mixed cart yields
    // two orders — both returned. The split reads the SERVER's on_hand
    // (api/_merch.js splitQuickSaleLines), not the count the phone saw.
    const split = splitQuickSaleLines(lines, loaded.variants);
    const instant = split.instant;
    const preorder = split.preorder;
    const orders = [];
    // One PayPal payment covers the whole cart, so the pass-through fee is
    // computed ONCE on the cart total and carried by the first order this
    // cart produces (a mixed cart's second order carries 0) — the two
    // records still sum to what the buyer was actually charged.
    let cartFee = orderFeeCents(method, instant.concat(preorder).reduce((s, l) => s + l.qty * l.price_cents_each, 0));

    if (instant.length) {
      const total = instant.reduce((s, l) => s + l.qty * l.price_cents_each, 0);
      const ins = await sql`
        INSERT INTO merch_desk_orders (family_email, buyer_name, status, payment_method, paid_at, total_cents, fee_cents, note, created_by_email, source)
        VALUES (${famEmail}, ${buyerName}, 'delivered', ${method}, NOW(), ${total}, ${cartFee}, ${note}, ${email}, 'event')
        RETURNING id, family_email, buyer_name, status, payment_method, paid_at, total_cents, fee_cents, note, created_at, source
      `;
      cartFee = 0;
      const order = ins[0];
      for (const l of instant) {
        await sql`
          INSERT INTO merch_desk_order_items (order_id, variant_id, qty, price_cents_each, stock_status)
          VALUES (${order.id}, ${l.variant_id}, ${l.qty}, ${l.price_cents_each}, 'allocated')
        `;
        // DELIBERATE exception to the truthful-decrement rule (2026-08-15
        // review finding 4): the instant sale is the manager's own hands
        // handing the item across the table — it physically left,
        // whatever the count said — so the clamp stays and the line is
        // 'allocated' in full. A delivered order can't be cancelled, so
        // this can never restore phantom stock; a wrong count is fixed by
        // a recount (merch-stock-adjust).
        await sql`UPDATE merch_variants SET on_hand = GREATEST(on_hand - ${l.qty}, 0), updated_at = NOW() WHERE id = ${l.variant_id}`;
      }
      orders.push(order);
    }

    if (preorder.length) {
      // Pre-orders are cancellable, so THEY use the truthful path
      // (api/_merch.js allocateOrderLines): allocated only for units the
      // shelf really gave up, backordered for the rest.
      const why = [];
      if (split.reasons.printed) why.push('printed to order');
      if (split.reasons.out) why.push('out of stock at the table');
      const preNote = (note ? note + ' — ' : '') + 'Pre-order from the merch table (' + why.join('; ') + ').';
      const ins = await sql`
        INSERT INTO merch_desk_orders (family_email, buyer_name, status, payment_method, paid_at, total_cents, fee_cents, note, created_by_email, source)
        VALUES (${famEmail}, ${buyerName}, 'paid', ${method}, NOW(), ${orderTotalCents(preorder)}, ${cartFee}, ${preNote.slice(0, 500)}, ${email}, 'event')
        RETURNING id, family_email, buyer_name, status, payment_method, paid_at, total_cents, fee_cents, note, created_at, source
      `;
      cartFee = 0;
      const order = ins[0];
      await allocateOrderLines(sql, order.id, preorder);
      orders.push(order);
    }

    const linesByOrder = await merchLinesByOrder(sql, orders.map(o => o.id));
    const withLines = orders.map(o => Object.assign({}, o, { lines: linesByOrder[o.id] || [] }));
    // `order` = the first (instant sale when present) for older clients;
    // `orders` = everything this cart produced; `preorder_reasons` says
    // WHY lines were held back so the confirmation can name it.
    return res.status(201).json({
      order: withLines[0], orders: withLines,
      preorder: preorder.length > 0,
      preorder_reasons: split.reasons
    });
  }

  // ── Merch Finances (Erin, 2026-08-16: "keep track of $$: sales,
  // expenses, cash, etc.") ──
  // One school year at a time (April-1 flip, activeSchoolYear — the same
  // helper the billing card uses; NOT MAX-of-rows). The ledger merges:
  //   - every PAID Desk order (status not cancelled, unscreened) — a
  //     'sale' dated by paid_at (Indianapolis day), amount = total_cents;
  //   - every paid legacy web-form order (merch_orders — no price on
  //     file) — a 'sale' with amount null: listed + flagged, never summed;
  //   - the manager's manual entries (merch_ledger_entries: expense /
  //     deposit / adjustment) — voided rows come back with voided = true
  //     so the grid can dim them; the summary skips them.
  // Amounts are SIGNED here (api/_merch.js ledgerSignedCents) so the
  // client's Amount column and the summary math read the same numbers.
  if (action === 'merch-finances') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const activeLabel = activeSchoolYear();
    const wanted = String(req.query.school_year || activeLabel);
    const bounds = schoolYearBounds(wanted);
    if (!bounds) return res.status(400).json({ error: 'school_year must look like 2026-2027.' });

    const deskRows = await sql`
      SELECT o.id, o.buyer_name, o.family_email, o.payment_method, o.paid_at, o.total_cents, o.fee_cents,
             o.source, o.status, o.note, o.created_by_email,
             to_char(o.paid_at AT TIME ZONE 'America/Indianapolis', 'YYYY-MM-DD') AS paid_day
      FROM merch_desk_orders o
      WHERE o.paid_at IS NOT NULL
        AND o.status <> 'cancelled'
        AND o.screen_reason = ''
        AND (o.paid_at AT TIME ZONE 'America/Indianapolis')::date >= ${bounds.start}::date
        AND (o.paid_at AT TIME ZONE 'America/Indianapolis')::date <  ${bounds.end}::date
      ORDER BY o.paid_at DESC
    `;
    const linesByOrder = await merchLinesByOrder(sql, deskRows.map(o => o.id));
    const rows = deskRows.map(o => {
      const lines = linesByOrder[o.id] || [];
      const items = lines.map(l => l.qty + ' × ' + l.item_name + (l.variant_label ? ' — ' + l.variant_label : '')).join(' · ');
      const src = o.source || (o.created_by_email === 'public-form' ? 'web' : (o.family_email ? 'portal' : 'event'));
      return {
        key: 's' + o.id, kind: 'sale', id: o.id, order_id: o.id,
        date: o.paid_day, at: o.paid_at,
        type: 'sale',
        description: (o.buyer_name || '(no name)') + (items ? ' — ' + items : ''),
        items,
        buyer: o.buyer_name || '', family_email: o.family_email || '',
        source: src === 'event' ? 'Event' : 'Web',
        method: o.payment_method || '',
        // Pass-through PayPal fee the buyer paid on top (never reaches the
        // co-op, so it is NOT in amount_cents) — shown beside the method.
        fee_cents: o.fee_cents || 0,
        amount_cents: ledgerSignedCents('sale', o.total_cents),
        note: o.note || '',
        voided: false, priced: true,
        order_status: o.status
      };
    });

    // Legacy homepage-form orders (2026-05 ledger): paid_at is the money
    // event; there is no price column, so the amount is unknown.
    try {
      const legacy = await sql`
        SELECT id, customer_name, item, size, color, qty, paid_at, notes,
               to_char(paid_at AT TIME ZONE 'America/Indianapolis', 'YYYY-MM-DD') AS paid_day
        FROM merch_orders
        WHERE paid_at IS NOT NULL AND screen_reason = ''
          AND (paid_at AT TIME ZONE 'America/Indianapolis')::date >= ${bounds.start}::date
          AND (paid_at AT TIME ZONE 'America/Indianapolis')::date <  ${bounds.end}::date
        ORDER BY paid_at DESC
      `;
      legacy.forEach(o => {
        const itemTxt = (o.qty || 1) + ' × ' + (o.item || '') + (o.size ? ' — ' + o.size : '') + (o.color ? (o.size ? ' · ' : ' — ') + o.color : '');
        rows.push({
          key: 'w' + o.id, kind: 'legacy', id: o.id, order_id: null,
          date: o.paid_day, at: o.paid_at,
          type: 'sale',
          description: (o.customer_name || '(no name)') + ' — ' + itemTxt,
          items: itemTxt,
          buyer: o.customer_name || '', family_email: '',
          source: 'Web',
          method: '',
          amount_cents: null,
          note: o.notes || '',
          voided: false, priced: false
        });
      });
    } catch (legacyErr) {
      console.error('merch-finances legacy read (non-fatal):', legacyErr);
    }

    const entries = await sql`
      SELECT id, school_year, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, type, amount_cents, method,
             description, note, created_by_email, created_at, voided_at
      FROM merch_ledger_entries
      WHERE school_year = ${wanted}
      ORDER BY entry_date DESC, id DESC
    `;
    entries.forEach(e => {
      rows.push({
        key: 'e' + e.id, kind: 'entry', id: e.id, order_id: null,
        date: e.entry_date, at: e.created_at,
        type: e.type,
        description: e.description || '',
        buyer: '', family_email: '', source: '',
        method: e.method || '',
        amount_cents: ledgerSignedCents(e.type, e.amount_cents),
        note: e.note || '',
        voided: !!e.voided_at, priced: true,
        entry: {
          id: e.id, entry_date: e.entry_date, type: e.type, amount_cents: e.amount_cents,
          method: e.method, description: e.description || '', note: e.note || '',
          created_by_email: e.created_by_email, created_at: e.created_at, voided_at: e.voided_at
        }
      });
    });

    // Season picker: every school year that has money in it, oldest
    // first, plus the active one.
    const years = [];
    try {
      const firstSale = await sql`SELECT MIN(paid_at) AS m FROM merch_desk_orders WHERE paid_at IS NOT NULL`;
      const firstEntry = await sql`SELECT MIN(entry_date) AS m FROM merch_ledger_entries`;
      const firsts = [firstSale[0] && firstSale[0].m, firstEntry[0] && firstEntry[0].m]
        .filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d.getTime()));
      const activeFall = parseInt(activeLabel.slice(0, 4), 10);
      let fall = activeFall;
      if (firsts.length) {
        const earliest = firsts.sort((a, b) => a - b)[0];
        const ef = parseInt(activeSchoolYear(earliest).slice(0, 4), 10);
        if (Number.isFinite(ef) && ef < fall) fall = ef;
      }
      for (; fall <= activeFall; fall++) years.push(fall + '-' + (fall + 1));
    } catch (yErr) {
      console.error('merch-finances years (non-fatal):', yErr);
    }
    if (years.indexOf(wanted) === -1) years.push(wanted);
    if (years.indexOf(activeLabel) === -1) years.push(activeLabel);

    return res.status(200).json({
      school_year: wanted,
      active_school_year: activeLabel,
      bounds,
      years,
      rows,
      summary: financeSummary(rows)
    });
  }

  // Manual ledger entry — create or edit (id present). Voided rows are
  // frozen: edit is refused so the audit trail stays honest (void, then
  // add a corrected entry).
  if (action === 'merch-ledger-save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const f = normalizeLedgerEntry(body);
    if (f.error) return res.status(400).json({ error: f.error });
    // Season stamp from the entry's own date (April-1 flip) — an entry
    // dated in March lands in the season that ends that spring.
    const schoolYear = activeSchoolYear(new Date(f.entryDate + 'T12:00:00'));
    const id = body.id != null ? parseInt(body.id, 10) : null;
    let row;
    if (Number.isInteger(id) && id > 0) {
      const cur = await sql`SELECT id, voided_at FROM merch_ledger_entries WHERE id = ${id}`;
      if (!cur.length) return res.status(404).json({ error: 'Entry not found.' });
      if (cur[0].voided_at) return res.status(409).json({ error: 'That entry was voided — add a new one instead.' });
      const upd = await sql`
        UPDATE merch_ledger_entries
        SET school_year = ${schoolYear}, entry_date = ${f.entryDate}::date, type = ${f.type},
            amount_cents = ${f.amountCents}, method = ${f.method},
            description = ${f.description}, note = ${f.note}
        WHERE id = ${id}
        RETURNING id, school_year, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, type, amount_cents, method,
                  description, note, created_by_email, created_at, voided_at
      `;
      row = upd[0];
    } else {
      const ins = await sql`
        INSERT INTO merch_ledger_entries (school_year, entry_date, type, amount_cents, method, description, note, created_by_email)
        VALUES (${schoolYear}, ${f.entryDate}::date, ${f.type}, ${f.amountCents}, ${f.method}, ${f.description}, ${f.note}, ${email})
        RETURNING id, school_year, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, type, amount_cents, method,
                  description, note, created_by_email, created_at, voided_at
      `;
      row = ins[0];
    }
    return res.status(200).json({ entry: row });
  }

  // Void (never delete) a manual entry: stamps voided_at; the report dims
  // the row and drops it from every total. Idempotent.
  if (action === 'merch-ledger-void') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
    const upd = await sql`
      UPDATE merch_ledger_entries
      SET voided_at = COALESCE(voided_at, NOW())
      WHERE id = ${id}
      RETURNING id, school_year, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, type, amount_cents, method,
                description, note, created_by_email, created_at, voided_at
    `;
    if (!upd.length) return res.status(404).json({ error: 'Entry not found.' });
    return res.status(200).json({ entry: upd[0] });
  }

  return res.status(400).json({ error: 'Unknown merch action' });
}

// Exposed for dev-DB test harnesses (a property on the exported handler
// function — inert at runtime; Vercel only ever calls the function).
module.exports._merchTest = { handleMerchDeskActions, canManageMerchDesk };
