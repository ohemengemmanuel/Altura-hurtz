# Altura Hertz Productions website

Website for Altura Hertz Productions, a recording studio offering recording, mixing and mastering, custom beats and cover art.

## Folders

| Folder | Contents |
|---|---|
| `development/` | The website. Plain HTML, CSS and JavaScript, no build step. This is the folder to deploy. |
| `supabase/` | `schema.sql`: database, file storage, security rules and spam limits for bookings. `email-alerts.sql`: emails the studio about each new booking. |
| `design/` | Colour template, original studio photos and design references. |
| `documentation/` | `Deployment and Change Log.docx` (how the site works, deployment steps, change history) and the original brief. |

## Run it locally

```
cd development
python -m http.server 8000
```

Then open http://localhost:8000.

## Bookings (Supabase)

Booking forms save to a Supabase database, and the studio manages them at `/studio.html`. That page isn't linked from the public site. Netlify still hosts the website itself.

1. Create a project at https://supabase.com.
2. SQL Editor > New query: paste `supabase/schema.sql` and run it. This creates the bookings table, a private `booking-files` bucket for uploads, and the security rules. Visitors can only submit; staff can read and update.
3. Authentication > Users > Add user: create the studio login (tick Auto Confirm). Then add it to the staff list with the SQL at the end of `schema.sql`.
4. Authentication > Sign In / Providers: turn off "Allow new users to sign up".
5. Authentication > URL Configuration: set Site URL to the live site and add `https://<your-site>/studio.html` to Redirect URLs, so password reset links work.
6. Project Settings > API: copy the Project URL and the publishable key into `supabase` in `development/js/config.js`.

7. Email alerts for new bookings, with the client's files attached: sign up at https://resend.com, create an API key, and save it in Supabase > Integrations > Vault as a secret named `resend_api_key`. Deploy the Edge Function in `supabase/functions/booking-alert/index.ts` (Edge Functions > Deploy a new function > Via Editor, name `booking-alert`, then turn off "Verify JWT" in its settings). Then run `supabase/email-alerts.sql` in the SQL Editor. Files too big to attach come as 14-day download links, and uploaded files are deleted from Supabase 14 days after the email to keep storage within the free plan.
8. Automatic client emails and slot holds: turn on 2-Step Verification for the studio Google account, create an app password at https://myaccount.google.com/apppasswords, and save it in the Vault as `gmail_app_password`. Run `supabase/client-emails.sql`, then paste the latest `supabase/functions/booking-alert/index.ts` into the booking-alert function and deploy it again. Set the payment details clients see:
   `update public.notification_settings set payment_instructions = 'MTN MoMo: 024 000 0000 (Account name)';`
   Pressing Confirmed on the dashboard emails the client the amount and payment details and holds the slot for 3 hours (`hold_hours`). Pressing Paid emails a "payment received" note and blocks the slot for good. Pressing Cancelled can email a cancellation. The booking form greys out taken times.

Until step 6 is done, clients get a booking summary to send on WhatsApp or email instead. The same happens if a submission fails.

The dashboard shows new bookings live, a schedule view that flags overlapping sessions, status tracking (new, confirmed, paid, completed, cancelled), private studio notes, and download links for uploaded files. Uploads are limited to 50 MB per file on the Supabase free plan. Clients can share bigger files as a link.

## Before launch

Contact details, social links, discount rates and the Supabase keys are placeholders in `development/js/config.js`. See the checklist in `documentation/Deployment and Change Log.docx`.
