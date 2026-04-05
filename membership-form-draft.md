# Membership Agreement & Liability Waiver — Google Form Draft

## Form Title
**2025/2026 Member Agreement and Liability Waiver**

## Form Description
Please read each section carefully and complete all fields. One form per family. If you have questions or concerns, contact the board at board@rootsandwingsindy.com.

---

## Section 1: Family Information

**Field 1:** Parent/Guardian Full Name
- Type: Short text
- Required: Yes

**Field 2:** Email Address
- Type: Short text (or use "Collect email addresses" in Form settings)
- Required: Yes

**Field 3:** Student Name(s) and Age(s)
- Type: Long text
- Required: Yes
- Helper text: "List each student's full name and age, one per line"

---

## Section 2: Member Agreement

**Description text (not a field — just display this):**

> **Member Requirements**
> - Sign member agreement, photo release and liability waiver
> - Pay facility fee upon registration
> - Active assigned adult will be present with student(s) each co-op day
>
> **Member Expectations**
> - Reasonable family attendance at co-op
> - Reasonable participation at parent meetings
> - Reasonable participation in special events and field trips
> - Pay class fees on time before/on the first day of co-op each session
> - Sign up for classes on time
> - Active participation in the leadership and facilitation of daily co-op activities through volunteering, as outlined in the member handbook
>
> If you feel you cannot meet the membership requirements and/or expectations, please contact the board at board@rootsandwingsindy.com for assistance.

**Field 4:** Member Agreement Acknowledgment
- Type: Checkbox (single)
- Required: Yes
- Label: "I have been given and read the Roots and Wings Homeschool Co-op Inc. handbook and agree to work with Co-op members to complete the requirements and expectations of membership."

---

## Section 3: Photo/Media Consent

**Description text:**

> I hereby consent to the participation in interviews, the use of quotes, and the taking of photographs, movies or video tapes of myself and the Student(s) named above by Roots and Wings Homeschool Co-op.
>
> I also grant to Roots and Wings Homeschool Co-op the right to edit, use, and reuse said products for non-profit purposes including use in print (e.g. the yearbook), on the internet, and all other forms of media. I also hereby release Roots and Wings Homeschool Co-op and its agents and employees from all claims, demands, and liabilities whatsoever in connection with the above.

**Field 5:** Photo/Media Consent
- Type: Multiple choice
- Required: Yes
- Options:
  - "I consent to photo/media use as described above"
  - "I do NOT consent to photo/media use"

---

## Section 4: Liability Waiver

**Description text:**

> "My child/children and I participate with Roots and Wings Homeschool Co-op Inc. which meets once a week at the First Mennonite Church for group lessons. I recognize that my child's/children's and my participation with Roots and Wings Homeschool Co-op at the First Mennonite Church, although there is no strenuous physical activity during these lessons, could result in possible injury due to accidents or other circumstances during time spent in the church building or other co-op activities. I hereby affirm that my child/children and I are in good physical condition and do not suffer from any known disability or condition which would keep us from participation in this time spent at First Mennonite Church. I acknowledge that my child's/children's and my participation in Roots and Wings Homeschool Co-op Inc. is purely voluntary and in no way mandated by Roots and Wings Homeschool Co-op Inc. or First Mennonite Church."
>
> "In consideration of my child's/children's and my participating with Roots and Wings Homeschool Co-op Inc., I hereby release Roots and Wings Homeschool Co-op Inc. and First Mennonite Church and its agents from any claims, demands, and causes of action as a result of my child's/children's and my participation and enrollment."
>
> "I fully understand that if my child/children or I suffer an injury as a result of participating with Roots and Wings Homeschool Co-op Inc. while at First Mennonite Church, I hereby release Roots and Wings Inc. and First Mennonite Church and its agents from any liability now or in the future for conditions that my child/children or I may obtain. These conditions may result in serious injury or death."

**Field 6:** Liability Waiver Acknowledgment
- Type: Checkbox (single)
- Required: Yes
- Label: "I HEREBY AFFIRM THAT I HAVE READ AND FULLY UNDERSTAND THE ABOVE STATEMENTS."

---

## Section 5: Signature

**Field 7:** Parent/Guardian Signature
- Type: Short text
- Required: Yes
- Helper text: "Type your full legal name as your electronic signature"

**Field 8:** Date
- Type: Date
- Required: Yes

**Field 9:** Student Signature (if 18 or over)
- Type: Short text
- Required: No
- Helper text: "Only required if student is 18 or older. Type full legal name."

---

## Google Form Settings to Enable
- **Collect email addresses** (Settings > Responses) — auto-captures their Workspace email
- **Limit to 1 response** (Settings > Responses) — prevents duplicate submissions
- **Send responders a copy** — so families have their own receipt
- **Link responses to a Google Sheet** (Responses tab > Link to Sheets)

## Tracking Sheet Setup
In the linked response sheet, add a second tab called "Tracking" with:
- Column A: Full member roster (family names)
- Column B: Formula to check if they've submitted:
  `=IF(COUNTIF(Responses!B:B, "*"&A2&"*"), "Signed", "NOT SIGNED")`
  (adjust column references to match your actual response columns)
