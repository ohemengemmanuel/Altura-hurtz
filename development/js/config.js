/* Site settings for Altura Hertz Productions.
   Edit the values in this file to change prices, discounts and contact details.
   Values marked TODO are placeholders and must be confirmed before launch
   (see documentation/Deployment and Change Log.docx). */

window.AH_CONFIG = {
  studioName: "Altura Hertz Productions",
  currency: "GH₵",

  contact: {
    phone: "+233 00 000 0000",        // TODO: studio phone number
    whatsapp: "233000000000",         // TODO: WhatsApp number, digits only with country code
    email: "bookings@alturahertz.com", // TODO: booking email address
    location: "Accra, Ghana",         // TODO: studio address or area
    hours: "Monday to Sunday, 11:00 to 23:00", // TODO: opening hours
    // Social profiles for the footer icons. Paste the full link, for example
    // "https://www.instagram.com/alturahertz". Icons with no link still show but do nothing when clicked.
    facebook: "",                     // TODO: Facebook page URL
    instagram: "",                    // TODO: Instagram profile URL
    threads: "",                      // TODO: Threads profile URL
    youtube: "",                      // TODO: YouTube channel URL
    tiktok: ""                        // TODO: TikTok profile URL
  },

  // Session start times offered in the booking form (24 hour clock).
  sessionStartTimes: ["11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"],
  maxSessionHours: 6,
  closingTime: "23:00",     // sessions must end by this time
  maxTracks: 20,

  pricing: {
    recordingPerHour: 100,   // from the brief
    mixMasterPerTrack: 450,  // from the brief

    // Discount tiers. TODO: confirm the real rates with the studio.
    // A tier applies when the quantity is at or above "min".
    recordingHourDiscounts: [
      { min: 2, percent: 10 }
    ],
    mixMasterTrackDiscounts: [
      { min: 2, percent: 10 },
      { min: 4, percent: 15 },
      { min: 6, percent: 20 }
    ]
  },

  // Payment options shown on booking forms. Use "logo" (an image path) or "icon" (a Material Symbols name).
  // Online payment is not connected yet. Clients choose a method and the studio
  // sends payment details when it confirms the booking.
  paymentMethods: [
    { id: "mtn-momo", label: "MTN MoMo", note: "Mobile money", logo: "assets/img/pay-mtn.webp" },
    { id: "telecel-cash", label: "Telecel Cash", note: "Mobile money", logo: "assets/img/pay-telecel.webp" },
    { id: "bank-card", label: "Card or bank transfer", note: "Details sent on confirmation", icon: "account_balance" }
  ],

  // Where booking forms are saved. Bookings appear on the studio dashboard (studio.html).
  // Supabase dashboard > Project Settings > API: copy the Project URL and the publishable (or anon) key.
  // The publishable key is safe to show in the browser. Never paste the secret or service_role key here.
  // Set up the database first with supabase/schema.sql.
  // While these are empty, clients get a booking summary to send on WhatsApp or email.
  supabase: {
    url: "https://bacqqxokyqhehqadnlcy.supabase.co",
    anonKey: "sb_publishable__iirqcFkFj503AnHHWD4Mw_srf7hjZM"
  },
  maxUploadMB: 50, // per file; matches the booking-files bucket limit in supabase/schema.sql

  // Optional alternative to Supabase: Formspree (https://formspree.io) or any endpoint that
  // accepts multipart form posts. Only used when Supabase is not set up.
  formEndpoint: ""
};
