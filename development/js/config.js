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
    hours: "Monday to Sunday, 10:00 to 22:00", // TODO: opening hours
    // Social profiles for the footer icons. Paste the full link, for example
    // "https://www.instagram.com/alturahertz". Icons with no link still show but do nothing when clicked.
    facebook: "",                     // TODO: Facebook page URL
    instagram: "",                    // TODO: Instagram profile URL
    threads: "",                      // TODO: Threads profile URL
    youtube: "",                      // TODO: YouTube channel URL
    tiktok: ""                        // TODO: TikTok profile URL
  },

  // Session start times offered in the booking form (24 hour clock).
  sessionStartTimes: ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"],
  maxSessionHours: 12,
  maxTracks: 20,

  pricing: {
    recordingPerHour: 100,   // from the brief
    mixMasterPerTrack: 450,  // from the brief

    // Discount tiers. TODO: confirm the real rates with the studio.
    // A tier applies when the quantity is at or above "min".
    recordingHourDiscounts: [
      { min: 3, percent: 10 },
      { min: 5, percent: 15 },
      { min: 8, percent: 20 }
    ],
    mixMasterTrackDiscounts: [
      { min: 2, percent: 10 },
      { min: 4, percent: 15 },
      { min: 6, percent: 20 }
    ]
  },

  // Payment options shown on booking forms.
  // Online payment is not connected yet. Clients choose a method and the studio
  // sends payment details when it confirms the booking.
  paymentMethods: [
    { id: "mtn-momo", label: "MTN MoMo", note: "Mobile money", icon: "smartphone" },
    { id: "telecel-cash", label: "Telecel Cash", note: "Mobile money", icon: "smartphone" },
    { id: "at-money", label: "AT Money", note: "Mobile money", icon: "smartphone" },
    { id: "bank-card", label: "Card or bank transfer", note: "Details sent on confirmation", icon: "credit_card" },
    { id: "at-studio", label: "Pay at the studio", note: "Cash or MoMo on the day", icon: "storefront" }
  ],

  // Where booking forms are sent. Leave empty until a form service is set up.
  // Works with Formspree (https://formspree.io) or any endpoint that accepts multipart form posts.
  // While empty, clients get a booking summary to send on WhatsApp or email.
  formEndpoint: ""
};
