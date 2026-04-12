// Seed the cleaning crew tables from current hardcoded data.
// Idempotent: wipes existing rows and re-inserts.
// Run with: node --env-file=.env.local scripts/seed-cleaning.js

const { neon } = require('@neondatabase/serverless');

const AREAS = [
  // [floor_key, area_name, tasks[], sort_order]
  ['mainFloor', 'Classrooms & MPR', [
    'Remove bagged trash from the rooms and place in the hall by the entranceway',
    'Replace trash bags in the cans in each room',
    'Sweep as needed',
    'Wipe surfaces as needed',
    'Reset chairs around tables as needed',
    'Turn off lights to show rooms are cleaned'
  ], 0],
  ['mainFloor', 'Kitchen', [
    'Remove bagged trash from the kitchen and place in the hall by the entranceway',
    'Replace trash bags in the kitchen',
    'Sweep as needed',
    'Wipe surfaces as needed',
    'Take home kitchen towels to launder and return the following week',
    'Ensure the coffee pot(s) are off and unplugged',
    'Ensure the ovens are off',
    'Ensure the freezer & refrigerator doors are securely closed',
    'Turn off lights to show kitchen is cleaned'
  ], 1],
  ['mainFloor', 'Kitchen Annex & FH', [
    'Remove bagged trash from the kitchen annex and FH and place in the hall by the entranceway',
    'Replace trash bags in the kitchen annex and FH',
    'Sweep or vacuum as needed',
    'Wipe surfaces as needed',
    'Reset chairs, tables, and other items (in FH) as needed',
    'Turn off lights to show rooms are cleaned'
  ], 2],
  ['mainFloor', 'Hallways', [
    'Sweep or vacuum as needed',
    'Wipe surfaces as needed',
    'Clean entryway floors (sweep) and glass doors (glass cleaner)',
    'Turn off lights to show halls are cleaned'
  ], 3],
  ['mainFloor', 'Bathrooms', [
    'Remove trash in bags and place in the hall by the entranceway',
    'Replace trash bags in all bathrooms',
    'Wipe surfaces with disinfecting wipes',
    'Turn off lights to show bathrooms are cleaned'
  ], 4],
  ['upstairs', 'Classrooms', [
    'Remove bagged trash from the rooms and place in the hall by the entranceway',
    'Replace trash bags in the cans in each room',
    'Sweep as needed',
    'Wipe surfaces as needed',
    'Reset chairs around tables as needed',
    'Turn off lights to show rooms are cleaned'
  ], 0],
  ['upstairs', 'Bathrooms', [
    'Remove trash in bags and place in the hall by the entranceway',
    'Replace trash bags in all bathrooms',
    'Wipe surfaces with disinfecting wipes',
    'Turn off lights to show bathrooms are cleaned'
  ], 1],
  ['upstairs', 'Halls & Stairs', [
    'Sweep/Vacuum as needed',
    'Wipe surfaces, including handrails, as needed',
    'Turn off lights to show areas are cleaned'
  ], 2],
  ['outside', 'Garage & Grounds', [
    'Remove trash from the garage/pavilion',
    'Replace trash bag in the garage/pavilion',
    'Spot check the playground and surrounding areas for trash and debris',
    'Take ALL trash (inside trash should be placed by the entranceway) to the dumpster — wait until inside trash has been collected',
    'Turn off light to show garage is cleaned',
    'Close and lock garage doors'
  ], 0],
  ['floater', 'Floater', [
    'Available to cover any last-minute absences from the Cleaning Crew',
    'Familiar with all cleaning area tasks',
    'Not necessarily the one to cover planned/advance notice absences'
  ], 0]
];

// Session 4 assignments: [floor_key, area_name, family_name]
const ASSIGNMENTS_S4 = [
  ['mainFloor', 'Classrooms & MPR', 'Anderson'],
  ['mainFloor', 'Classrooms & MPR', 'Baker'],
  ['mainFloor', 'Kitchen', 'Chen'],
  ['mainFloor', 'Kitchen', 'Davis'],
  ['mainFloor', 'Kitchen Annex & FH', 'Foster'],
  ['mainFloor', 'Kitchen Annex & FH', 'Garcia'],
  ['mainFloor', 'Hallways', 'Hughes'],
  ['mainFloor', 'Bathrooms', 'Johnson'],
  ['upstairs', 'Classrooms', 'Keller'],
  ['upstairs', 'Bathrooms', 'Martinez'],
  ['upstairs', 'Halls & Stairs', 'Mitchell'],
  ['outside', 'Garage & Grounds', 'Morris'],
  ['floater', 'Floater', 'Nguyen']
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local scripts/seed-cleaning.js');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  // Clear existing data
  console.log('Clearing cleaning tables...');
  await sql`DELETE FROM cleaning_assignments`;
  await sql`DELETE FROM cleaning_areas`;

  // Insert areas
  console.log(`Inserting ${AREAS.length} cleaning areas...`);
  const areaIds = {};
  for (const [floor_key, area_name, tasks, sort_order] of AREAS) {
    const rows = await sql`
      INSERT INTO cleaning_areas (floor_key, area_name, tasks, sort_order, updated_by)
      VALUES (${floor_key}, ${area_name}, ${tasks}, ${sort_order}, 'seed')
      RETURNING id
    `;
    areaIds[floor_key + '::' + area_name] = rows[0].id;
  }

  // Insert session 4 assignments
  console.log(`Inserting ${ASSIGNMENTS_S4.length} session 4 assignments...`);
  for (let i = 0; i < ASSIGNMENTS_S4.length; i++) {
    const [floor_key, area_name, family_name] = ASSIGNMENTS_S4[i];
    const areaId = areaIds[floor_key + '::' + area_name];
    await sql`
      INSERT INTO cleaning_assignments (session_number, cleaning_area_id, family_name, sort_order, updated_by)
      VALUES (4, ${areaId}, ${family_name}, ${i}, 'seed')
    `;
  }

  // Set liaison
  await sql`UPDATE cleaning_config SET liaison_name = 'Parn Sudmee', updated_by = 'seed' WHERE id = 1`;

  console.log('Done. Area IDs:', areaIds);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
