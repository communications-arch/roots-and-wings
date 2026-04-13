// Seed role_descriptions table with all 28 volunteer and board role descriptions.
// Idempotent: uses INSERT ... ON CONFLICT to upsert.
// Run with: node --env-file=.env.local scripts/seed-role-descriptions.js

const { neon } = require('@neondatabase/serverless');

// [role_key, title, job_length, overview, duties[], committee, last_reviewed_by, last_reviewed_date]
const ROLES = [
  ['admin_organization', 'Admin/Organization', '1 year',
    'Serves on Administrative Committee with the Secretary.',
    ['Helps the Secretary with any admin/organization duties', 'Helps to maintain the all co-op binder with updated paper copies of organization information', 'Assists with organizing meeting minutes on digital platforms', 'Review and update job description at the end of the year'],
    'Administrative Committee', '', ''],

  ['afternoon_class_liaison', 'Afternoon Class Liaison', '1 year',
    'Serves as a member of the Programming Committee with the VP. The Afternoon Liaison organizes volunteers for the afternoon classes at co-op.',
    ['Brainstorm and collect ideas for afternoon classes prior to the start of the year and then periodically before each session', 'Support new class leaders by offering to connect them with a co-leader or mentor and periodically checking in with them to offer additional support', 'Ensure that each age group has at least two to three class options', 'Enter class info into the sign-up sheet', 'Secure teachers for afternoon classes', 'Follow up to ensure all kids are signed up for classes and parents are signed up for volunteer positions'],
    'Programming Committee', 'C.Cruz', '4/27/24'],

  ['classroom_instructor', 'Classroom Instructor', '1 session',
    'Develop class curriculum and facilitate with assistant instructors.',
    ['Will have observed and/or been a helper in a classroom for at least one session before being a lead teacher', 'Plans curriculum for one 5-week session of co-op for specific class', 'Writes a class description and submits to Class Liaison in a timely manner', 'Arranges for supplies to be brought to class', 'Has all supplies ready at the time of teaching', 'In the event of absence, contacts class liaison and provides materials/plans to substitute', 'Communicates with parents via email, chat space, etc. as needed', 'Communicates with Class Liaison about any help needed in the classroom', 'Can request a certain classroom helper or co-instructor', 'Notifies Class Liaison of any issues, concerns or complaints', 'Works with the Class Liaison to find a replacement if unable to complete session-long commitment', 'NOTE: Clean-up is not part of the role of the Classroom Instructor. Classroom Assistants clean up after class.'],
    'Programming Committee', 'C.Raymont', '2/4/26'],

  ['archives', 'Archives', '1 year',
    'Helps to facilitate the collection and organization of classroom materials for future use.',
    ['Serves as part of the Administrative Committee with Secretary', 'Helps to facilitate the collection and organization of classroom materials for future use (currently digital through google drive)', 'Review and update job description at the end of the year'],
    'Administrative Committee', '', ''],

  ['building_closer', 'Building Closer', '1 year',
    'Holds a key to the church and is responsible for making sure that classrooms, lunchroom, kitchen, bathrooms, halls, outside areas, etc., are cleaned and lights are out before locking up. Part of the Facility Committee. Usually filled by the President.',
    ['Check all rooms to make sure they are clean and lights turned off, and garbage taken out if needed', 'Lock supply cabinets in classrooms', 'Check bathrooms to make sure they are clean', 'Check that the kitchen is clean. Ensure refrigerator doors are closed, coffee pot and kettle off and unplugged, stove/ovens off', 'Turn off all lights', 'Lock the front doors at 3:25 PM', 'Communicate to co-op Membership at large if there is an issue', 'Collects lost and found items, places them in the box in the storage closet, and communicates these items with the group via chat', 'Dispose of/donate lost and found items at the end of each session', 'Find a substitute for the day if you are unable to attend', 'Work with the President to find a replacement if you can no longer fulfill this role'],
    'Facility Committee', 'M. Bellner', '6/2/25'],

  ['classroom_assistant', 'Classroom Assistant', '1 session',
    'Available to help the instructor with all classroom responsibilities. Works to make the class go smoothly by providing teaching support, addressing behavior problems, gathering supplies, and cleaning up.',
    ['Gather and return the supplies from the supply cabinet', 'Take out the trash at the end of the class', 'Wipe down the tables', 'Spot sweep floors. Fully vacuum if needed at the end of class', 'Actively participate in supporting the class instructor during class time', 'Check attendance prior to class', 'Help keep a head count during class', 'Monitor kids going to and from the bathroom if they need help', 'Be prepared to substitute when needed', 'Find a substitute for the day if you are unable to attend', 'Work with the Vice President to find a replacement if needed'],
    'Programming Committee', 'M. Bellner', '9/23/25'],

  ['cleaning_crew_liaison', 'Cleaning Crew Liaison', '1 year',
    'Oversees the Cleaning Crew members which rotate every session. Member of the Facilities Committee.',
    ['1-year position', 'Member of the Facilities Committee (Board President, Chair)', 'Oversees the Cleaning Crew members which rotate every session', 'Works to ensure all Cleaning Crew positions (11) are filled each session', 'Directs Cleaning Crew members to the Cleaning Crew Tasks document prior to the first day of each session', 'Maintains communications via Google Chat', 'Answers any questions Cleaning Crew members have about their responsibilities throughout each session', 'Reports any cleaning items that are low in stock to the Supply Coordinator', 'Reports any broken or damaged items or areas of the facilities to the Facilities Chair (Board President)', 'Works with Cleaning Crew members and floaters to find coverage should absences occur'],
    'Facility Committee', 'M. Bellner', '6/4/25'],

  ['field_trip_coordinator', 'Field Trip Coordinator', '1 year',
    'Plans field trips for the co-op. Part of the Finance Committee with Treasurer.',
    ['Plan at least one field trip per session for the entirety of the co-op', 'Take liberties to plan additional field trips based on seasonal events, shows and performances, etc.', 'Make sure the field trips are well advertised to the group via Google Chat, announcements, etc.', 'Update the group at parent meetings as necessary', 'Find a substitute/replacement if you can no longer act as lead of this role'],
    'Finance Committee', 'LN', '8/13/22'],

  ['floater', 'Floater', '1 session',
    'Maintain common areas during morning session, fill-in as needed, support classroom coaches as needed, set-up for lunch, and other tasks as needed.',
    ['Help get anyone who is late to their classroom in a timely manner', 'Check in with each classroom to see if any supplies or subs are needed', 'Be available to fill in different job positions when needed. Check the Absence Alert to see if there is anything that needs done during your hour', 'Monitor hallways, if needed', 'Monitor the playground, if needed', 'Set up tables and chairs for lunch, if needed', 'Find a substitute for the day if you are unable to attend', 'Work with the Vice President to find a replacement if you can no longer complete this role'],
    'Facility Committee', 'M. Bellner', '9/23/25'],

  ['fundraising_coordinator', 'Fundraising Coordinator', '1 year',
    'Gathers information on fundraising goals and facilitates fundraising activities. Part of Finance Committee with Treasurer.',
    ['Gather information (goals set, past efforts, ideas, etc) that the group may have', 'Get a sense for the types of fundraising activities people are interested in', 'Initiate fundraising activities, facilitate participation, and report results to the treasurer', 'Update the group at parent meetings as necessary', 'Find a substitute/replacement if you can no longer act as lead of this role'],
    'Finance Committee', 'LN', '8/13/22'],

  ['gratitude_encouragement', 'Gratitude/Encouragement Leader', '1 year',
    'Help maintain member satisfaction and support with events/actions that show gratitude and encouragement. Part of the Support Committee under the Sustaining Director.',
    ['Monitor and start conversations in the General Homeschool chat space and the MVP chat space', 'Updates the Urgent Support Needed chat space when a member may need extra support during a critical time', 'Organize donations for flowers, a card, etc for members after the loss of a family member', 'Coordinate with the Sustaining Director and Teens Liaison to create grad gifts for those graduating 8th grade', 'Organize and obtain thank you gifts for board members at the end of their term'],
    'Support Committee', 'C. Cruz', '5/24/24'],

  ['morning_class_liaison', 'Morning Class Liaison', '1 year',
    'Helps to build community for their morning class, creates and maintains the morning class Google space and helps to coordinate morning class lead teachers and topics for each session. Part of the Programming Committee.',
    ['Create and oversee the class Google space', 'Open a dialogue with class parents to determine if the class will have snacks', 'Help to determine morning class instructors and subjects for each session', 'After a parent has agreed to lead a morning class, ensure their name and topic are added to the sign-up sheet', 'Email the Class Instructor Guidelines and confirm they understand their responsibilities', 'Communicate student allergies with lead teachers, assistants, and those bringing snacks', 'Provide reminders of appropriate pronoun usage to all classroom adults each session', 'Communicate class budget with lead teachers each session ($10 per student for morning)', 'Ensure that classes receive appropriate amounts of recess or social time', 'Be available to help brainstorm solutions with the classroom instructor as needed', 'Answer any questions from parents and teachers regarding morning classes', 'Work with the Vice-President to find a replacement if needed'],
    'Programming Committee', 'C. Cruz', '5/28/24'],

  ['opener', 'Building Opener', '1 year',
    'Opens the church each Wednesday and makes sure rooms are ready for the day. Holds one of the church keys. Part of the Facility Committee.',
    ['Arrives early each week before co-op starts (at least by 9:30 a.m.)', 'Opens co-op by unlocking the front door and setting the door to open', 'Turn on the lights', 'Unlock classrooms, supply closets, and cabinets', 'Clean up anything left from another group', 'Directs students to appropriate play areas prior to the start of co-op', 'Find a substitute for the day if you are unable to attend', 'Work with the President to find a replacement if you can no longer fulfill this role'],
    'Facility Committee', 'M. Bellner', '9/23/25'],

  ['parent_social_events', 'Parent Social Events', '1 year',
    'Facilitates the planning of parent social events throughout the year. Part of the Support Committee with the Sustaining Director.',
    ['Plans a variety of activities around the city/state for parents to gather and socialize', 'Updates Parent\'s Night Out chat group with activities', 'Creates polls as needed to gauge group interest and availability', 'Creates event on google calendar for planned events', 'Work with VP to find a replacement if you are no longer able to fulfill your duties'],
    'Support Committee', 'E. Bogan', '4/10/25'],

  ['public_communications', 'Public Communications', '1 year',
    'Maintains the public website and works with registration team to reach out to public when recruiting new members. Part of Membership Committee.',
    ['Maintains the public website', 'Works with registration team to reach out to public when recruiting new members'],
    'Membership Committee', '', ''],

  ['safety_coordinator', 'Safety Coordinator', '1 year',
    'Checks first aid kit, reviews safety procedures, and brings safety concerns to the Facilities Committee Chair. Member of the Facilities Committee.',
    ['Checks the first aid kit at the start of each session and orders/replenishes supplies as needed', 'Reviews all safety guidelines & procedures (fire, tornado, lightning, etc.) with membership twice a year at All Member Meetings', 'Brings any safety concerns to the Facilities Committee Chair (Board President)', 'Answers questions regarding safety issues in the member chat'],
    'Facility Committee', 'M. Bellner', '6/2/25'],

  ['special_events_liaison', 'Special Events Liaison', '1 year',
    'Finds volunteers to coordinate special events, then oversees the planning, advertising, and execution of these events. Part of the Support Committee.',
    ['Coordinates special activities outside the normal Wednesday happenings', 'Finds volunteer(s) to coordinate each special event', 'Oversee the planning, advertising, budget, and signing up for each event', 'Serves as a go-to person for the coordinator of each event', 'Goes to the President for any church usage requests', 'If a fee is to be covered by the co-op, ensures that fee is handled', 'Makes sure events are well advertised in the chat group', 'To advertise events on the website contact the communications director', 'Find a substitute/replacement if you can no longer act as lead of this role'],
    'Support Committee', 'M.Bellner', '6/3/25'],

  ['summer_social_events', 'Summer Social Events', '1 year',
    'Facilitates the planning of summer social events for the greater Roots and Wings community. Part of the Support Committee.',
    ['Plan a variety of summer activities throughout the city for the Roots and Wings Community', 'Some events can be members only, and others can be publicized for past and potential members', 'Be thoughtful of cost constraints for members and try to plan free activities as often as possible', 'Discuss with the treasurer the possibility of using some co-op funds to help support the cost of events', 'If unable to fulfill duties, work with the Sustaining Director to find a replacement'],
    'Support Committee', 'S. Rubel', '12/3/22'],

  ['supply_coordinator', 'Supply Coordinator', '1 year',
    'Coordinate, purchase as needed, and maintain supplies and supply area. Part of the Finance Committee with Treasurer.',
    ['Check on cleaning supplies in cleaning closet; notify President if supplies are needed (cleaning wipes, trash bags)', 'Purchase cleaning wipes and trash bags as needed. Also purchase zip-loc bags for church kitchen', 'Purchase items (for reimbursement) when low on general supplies: toner, printer paper, general classroom supplies', 'Facilitate large co-op purchases such as new vacuum cleaners or sweepers, printer etc.', 'Purchases over $100 need to be approved by Treasurer', 'Check on supply closet each week to organize and clean as needed', 'Ensure all items owned by R&W, as well as spaces designated for R&W storage, are clearly defined and marked', 'Facilitate end of the year supply and materials clean out and organization. Reset for upcoming year', 'Communicate with co-op at large and upcoming teachers regarding what supplies we have in stock', 'Communicate with co-op at large of any surplus items available to be used or donated', 'Maintain open line of communication with current teachers in case changes need to be made', 'Update the group at parent meetings as necessary', 'Find a substitute for the day if you are unable to attend', 'Work with the Vice President to find a replacement if you can no longer act as lead of this role'],
    'Finance Committee', 'A.Furnish', '7/30/22'],

  ['welcome_coordinator', 'Welcome Coordinator', '1 year',
    'Supports new families and co-op inquiries. Works on Membership Committee under the Membership Director.',
    ['Reach out to each new family the week before co-op is scheduled to begin to welcome them and answer questions', 'Throughout the year if a new member is added, reach out to answer any questions regarding Google Workspace', 'Within one month of the new family starting co-op, reach out again for any questions', 'Check in with family\'s student(s)\' liaison(s)', 'Assist membership coordinator in tours for families interested in co-op as needed', 'Work with the Membership Director to find a replacement if you can no longer act as lead'],
    'Membership Committee', 'M.Bellner', '6/3/25'],

  ['yearbook_coordinator', 'Yearbook Coordinator', '1 year',
    'Decides on yearbook platform and photo-sharing platform, recruits and organizes volunteers, creates deadlines, and dedicates time to creating and finishing yearbook. Part of the Communications Committee.',
    ['Decides on yearbook platform and photo-sharing platform', 'Recruits and organizes student and parent volunteers to help with photographs and layout', 'Creates deadlines and calculates cost', 'Dedicates time to creating and finishing yearbook', 'Coordinate ordering of yearbook and collect money from members'],
    'Communications Committee', '', ''],

  ['president', 'President', '2 years',
    'The Board President convenes and presides over Board meetings. Communicates with the facility manager regarding use of the building. Responsible for negotiating building use fee and donations. Co-signer on the R&W checking account.',
    ['Officer of the Board', 'Chair of Facility Committee', 'Serves as Chief Volunteer for the organization', 'Works with the Vice-President and Board in making decisions that align with the mission statement', 'Schedules and plans all Board and Membership meetings', 'Prepares all agendas and meeting packets (sent out at least 2 weeks prior)', 'Presides over all Board and Membership meetings', 'Ensures a quorum is present at all meetings where voting is to take place', 'Encourages Board\'s role in strategic planning', 'Secures commitments for Facilities Committee positions for the upcoming year', 'Helps guide and mediate Board actions with respect to organizational priorities', 'Communicates to the facilities director as needed', 'Communicates with the Treasurer regarding semi-annual church payment and donations', 'Monitors financial planning and financial reports', 'Arranges for Board member to provide morning and afternoon announcements', 'Posts to the Google Announcements chat as needed', 'Clears class times and special events scheduling with the facilities director', 'Assigns classrooms for morning classes (annually) and afternoon classes (each session)', 'Updates, prints, and makes available the room assignment documents at the start of each session', 'Plans and facilitates volunteering opportunities with the facilities director', 'Reviews and updates job descriptions of volunteer positions', 'Ensures that outgoing volunteers on the Facilities committee update their job descriptions', 'Completes a walkthrough of the building at the end of each co-op day', 'Update the Member Handbook at the end of each co-op year with Communications Director', 'Has a one-on-one meeting with each officer of the Board in November before the end of the Board\'s term', 'Maintains a positive relationship between FMC and R&W', 'Negotiate the Building Use Agreement with FMC as needed', 'Assists in directing questions to the appropriate committee chair'],
    'Facility Committee', 'M. Bellner', '9/20/2025'],

  ['vice_president', 'Vice-President', '2 years',
    'Chair of the Programming Committee. Helps keep the co-op organized by making sure positions are filled and by working closely with all volunteers throughout the year.',
    ['Officer of the Board', 'Head of Programming Committee', 'Reports to the Board\'s President', 'Trains Morning and Afternoon Liaisons and assists them if needed', 'Organizes morning and afternoon class sign-up sheets', 'Secures commitments for Morning and Afternoon Liaison volunteer positions prior to the beginning of the year', 'Works with other Board Members to ensure their committee 1 year volunteer positions are filled', 'Works with morning and afternoon liaisons to make sure class topics and teachers are in place', 'Maintains the Coverage Tracker sheet and makes sure all absences are covered', 'Assists the other board members in executing the President\'s responsibilities when President cannot be available', 'Participates in the implementation of officer transitions', 'Reviews volunteer position descriptions annually', 'Works with the Board of Directors to find a replacement candidate if unable to fulfill the role', 'Ensure that outgoing volunteers on your committee update their job descriptions'],
    'Programming Committee', 'C Raymont', '9/22/25'],

  ['secretary', 'Secretary', '2 years',
    'Responsible for recording, distributing, and managing meeting minutes. Submits a form to the IRS annually.',
    ['Officer of the Board', 'Maintains records of the board and ensures effective management of organization\'s records', 'Manages minutes of board meetings', 'Ensures minutes are distributed to members shortly after each meeting', 'Is sufficiently familiar with legal documents to note applicability during meetings', 'Fills and submits Form 990-N to IRS annually', 'Ensure that outgoing volunteers on your committee update their job descriptions'],
    'Administrative Committee', '', ''],

  ['treasurer', 'Treasurer', '2 years',
    'Chair of the Finance Committee and manages all fiscal matters of the co-op. Provides a report at each Board meeting and Member meeting. Collects fees, distributes reimbursements, supports fundraising, manages administrative expenses, and maintains accurate financial records.',
    ['Member of the Board', 'Head of the Finance Committee', 'Administrator of finances for the organization', 'Provides an annual budget to the Board for Members\' approval', 'Ensures development and Board review of financial policies and procedures', 'Provides an update or report at each Board meeting and Member meeting', 'Receives and deposits co-op payments and registration fees', 'Receives receipts and distributes reimbursements for co-op-related purchases', 'Communicates budgets with Class Liaisons', 'Files tax documents annually as needed', 'Manages PayPal account', 'Sends invoices for Member fees', 'Ensures that outgoing financial committee members update their job descriptions'],
    'Finance Committee', 'J. Shewan', '9/24/2025'],

  ['membership_director', 'Membership Director', '2 years',
    'Coordinate and perform class registrations and facilitate the onboarding of new members.',
    ['Member of the Board', 'Communicate with all incoming new member inquiries in a timely manner', 'Give tours to prospective members', 'Determine time frame for registration period', 'Open pre-registration period for returning families', 'Open registration period for all other families', 'Create/edit registration documents', 'Create a Parent Directory with Pronouns, Allergy List, Contact information', 'Receive registrations', 'Work with the Treasurer to ensure proper payment', 'Work with Communications to ensure new members are setup in Google Workspace', 'Determine the age group/class split and assign class list', 'Update the group at parent meetings as necessary', 'Ensure that outgoing volunteers on your committee update their job descriptions'],
    'Membership Committee', 'TS', '09/22/2025'],

  ['sustaining_director', 'Sustaining Director', '2 years',
    'Attends board meetings and provides perspective and guidance as long-standing member of co-op.',
    ['Member of the Board', 'Chairperson of the Support committee', 'Reminds board of history of the organization', 'Is able to inform the board of beneficial and non-beneficial decisions of the past', 'Provides valuable perspective as a long-standing member', 'Acts as support to Special Events Coordinator, Gratitude/Encouragement, Parent Social Events Coordinator, and Summer Social Events Coordinators', 'Ensure that outgoing volunteers on your committee update their job descriptions'],
    'Support Committee', '', ''],

  ['communications_director', 'Communications Director', '2 years',
    'Chair of the Communications Committee and in charge of the internal communications of the organization.',
    ['Member of the Board', 'Head of the Communications Committee', 'Ensures that all essential co-op documents and GSuite maintains a second owner/admin/editor at all times', 'Works closely with Board Members to ensure clear internal communications', 'Maintains communications on all volunteer/job lists', 'Helps choose and maintain classroom communication consistency', 'Maintains website on accuracy and currency', 'Updates classes as sessions change', 'Posts information from members', 'Updates community calendar', 'Posts co-op links to forms', 'Make any updates to job descriptions as needed throughout the year', 'Get signatures for all waivers needed from each member each year'],
    'Communications Committee', 'E. Bogan', '12/5/25']
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local scripts/seed-role-descriptions.js');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  console.log(`Seeding ${ROLES.length} role descriptions...`);

  for (const [role_key, title, job_length, overview, duties, committee, last_reviewed_by, last_reviewed_date] of ROLES) {
    await sql`
      INSERT INTO role_descriptions (role_key, title, job_length, overview, duties, committee, last_reviewed_by, last_reviewed_date, updated_by)
      VALUES (${role_key}, ${title}, ${job_length}, ${overview}, ${duties}, ${committee}, ${last_reviewed_by}, ${last_reviewed_date}, 'seed')
      ON CONFLICT (role_key) DO UPDATE SET
        title = EXCLUDED.title,
        job_length = EXCLUDED.job_length,
        overview = EXCLUDED.overview,
        duties = EXCLUDED.duties,
        committee = EXCLUDED.committee,
        last_reviewed_by = EXCLUDED.last_reviewed_by,
        last_reviewed_date = EXCLUDED.last_reviewed_date,
        updated_at = NOW(),
        updated_by = 'seed'
    `;
    console.log(`  ok: ${role_key} — ${title}`);
  }

  console.log('Done. All role descriptions seeded.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
