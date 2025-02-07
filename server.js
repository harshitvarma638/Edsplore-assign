const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const {DateTime} = require("luxon");
const bodyParser = require("body-parser");

const PORT = 5000;
const credentials = JSON.parse(fs.readFileSync("credentials.json"));

const app = express();
app.use(bodyParser.json());

const oauth2Client = new google.auth.OAuth2(
  credentials.web.client_id,
  credentials.web.client_secret,
  credentials.web.redirect_uris[0]
);

oauth2Client.on('tokens', (tokens) => {
  if(tokens.refresh_token) {
    const existingTokens = fs.existsSync('token.json') ? JSON.parse(fs.readFileSync('token.json')) : {};
    existingTokens.refresh_token = tokens.refresh_token;
    fs.writeFileSync('token.json', JSON.stringify(existingTokens));
  }

  const existingTokens = JSON.parse(fs.readFileSync('token.json'));
  existingTokens.access_token = tokens.access_token;
  existingTokens.expiry_date = tokens.expiry_date;
  fs.writeFileSync('token.json', JSON.stringify(existingTokens));
});

app.get("/", (req,res) => {
  res.send("Hello World");
})

app.get("/auth", (req,res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
  });
  res.redirect(authUrl);
});

let tokenAddress = "token.json";
if(fs.existsSync(tokenAddress)) {
  const tokens = JSON.parse(fs.readFileSync(tokenAddress));
  oauth2Client.setCredentials(tokens);

  if(tokens.expiry_date && tokens.expiry_date < Date.now()) {
    oauth2Client.refreshAccessToken((err, tokens) => {
      if(err) {
        console.error("Error refreshing access token: ", err);
        return;
      }

      oauth2Client.setCredentials(tokens);
      fs.writeFileSync(tokenAddress, JSON.stringify(tokens));
    });
  }
}

const calendar = google.calendar({version: "v3", auth: oauth2Client});

app.get("/auth/callback", async (req,res) => {
  const {code} = req.query;

  if(!code) {
    return res.status(400).send("Missing authorization code.");
  }
  
  try{
    const {tokens} = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync("token.json", JSON.stringify({
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      scope: tokens.scope
    }));
    res.status(200).send("Authentication successful.");
  }
  catch(error) {
    console.error("Error retrieveing access token: ", error);
    res.status(400).send("Authentication failed.");
  }
});

async function ensureValidToken() {
  if(!fs.existsSync(tokenAddress)) {
    throw new Error('No token found, Please authenticate first.');
  }

  const tokens = JSON.parse(fs.readFileSync(tokenAddress));

  if(tokens.expiry_date && tokens.expiry_date < Date.now()) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      fs.writeFileSync(tokenAddress, JSON.stringify(credentials));
    }
    catch(error) {
      console.error("Error refreshing access token: ", error);
      throw new Error("Error refreshing access token: ", error);
    }
  }
}

app.post("/check_availability", async (req, res) => {
  try {
    await ensureValidToken();

    console.log(req.body);
    const { time_zone } = req.body.args;

    const timeNow = DateTime.now().setZone(time_zone);
    const next48Hours = timeNow.plus({ hours: 48 });

    const events = await calendar.events.list({
      calendarId: "primary",
      timeMin: timeNow.toISO(),
      timeMax: next48Hours.toISO(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const busySlots = events.data.items.map(event => ({
      start: DateTime.fromISO(event.start.dateTime || event.start.date, { zone: time_zone }).toMillis(),
      end: DateTime.fromISO(event.end.dateTime || event.end.date, { zone: time_zone }).toMillis(),
    }));

    const availableSlots = [];
    let currentTime = timeNow;

    for (let i = 0; i < 2; i++) {
      let startDay = currentTime.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }); // 9 AM
      let endDay = currentTime.set({ hour: 19, minute: 0, second: 0, millisecond: 0 }); // 7 PM

      if(i==0 && startDay < timeNow) {
        startDay = timeNow.plus({ minutes: 30 }).startOf("hour");
        if (startDay > endDay) {
          currentTime = currentTime.plus({ days: 1 }).startOf("day");
          continue;
        }
      }

      while (startDay < endDay) {
        let nextHour = startDay.plus({ hours: 1 });

        let isAvailable = !busySlots.some(slot => {
          return slot.start < nextHour.toMillis() && slot.end > startDay.toMillis();
        });

        if (isAvailable) {
          availableSlots.push({
            start: startDay.toISO(),
            end: nextHour.toISO(),
          });
        }

        startDay = nextHour;
      }

      currentTime = currentTime.plus({ days: 1 }).startOf("day");
    }

    res.status(200).json({ availableSlots });
  } catch (error) {
    console.error("Error fetching calendar events: ", error);
    res.status(400).send("Error fetching calendar events.");
  }
});

app.post("/save_booking", async (req,res) => {
  try{
    await ensureValidToken();

    console.log(req.body);
    const {user_email, appointment_time} = req.body.args;
    console.log(user_email, appointment_time);
    if(!user_email || !appointment_time) {
      return res.status(400).send("Missing required fields.");
    }

    const event = {
      summary: "Scheduled Appointment",
      description: `Appointment booked for ${user_email}`,
      start: {
        dateTime: appointment_time,
        timeZone: "Asia/Kolkata",
      },
      end: {
        dateTime: new Date(new Date(appointment_time).getTime() + 60*60*1000),
        timeZone: "Asia/Kolkata",
      },
      attendees: [{email: user_email}],
      reminders: {
        useDefault: false,
        overrides: [{method: "email", minutes: 20}, {method: "popup", minutes: 10}],
      },
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.status(200).json({
      message: "Appointment booked successfully.",
      eventId: response.data.id,
      start_time: event.start.dateTime,
      end_time: event.end.dateTime,
    });
  }
  catch(error) {
    console.error("Error saving booking: ", error);
    res.status(400).send("Error saving booking.");
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
