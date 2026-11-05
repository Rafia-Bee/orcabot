// The time zones force leaders can pick from when booking a timeslot.
// zoneOptions: dropdown options for each zone, showing what time it is there right now.
const { clock } = require("../time");

const ZONES = [
  ["Europe/London", "UK, Ireland, Portugal"],
  ["Europe/Berlin", "Central Europe (Berlin, Paris, Warsaw)"],
  ["Europe/Helsinki", "Eastern Europe (Helsinki, Athens, Kyiv)"],
  ["Europe/Istanbul", "Turkey"],
  ["Europe/Moscow", "Moscow"],
  ["Europe/Samara", "Samara"],
  ["Asia/Yekaterinburg", "Yekaterinburg"],
  ["Asia/Dubai", "Gulf (Dubai)"],
  ["Asia/Karachi", "Pakistan"],
  ["Asia/Kolkata", "India"],
  ["Asia/Bangkok", "Thailand, Vietnam, Indonesia (west)"],
  ["Asia/Singapore", "Singapore, Malaysia, Philippines"],
  ["Asia/Taipei", "Taiwan, Hong Kong, China"],
  ["Asia/Seoul", "Korea, Japan"],
  ["Australia/Perth", "Western Australia"],
  ["Australia/Sydney", "Eastern Australia"],
  ["Pacific/Auckland", "New Zealand"],
  ["America/Sao_Paulo", "Brazil (Sao Paulo)"],
  ["America/Argentina/Buenos_Aires", "Argentina"],
  ["America/Halifax", "Atlantic Canada"],
  ["America/New_York", "US and Canada east"],
  ["America/Chicago", "US and Canada central"],
  ["America/Denver", "US and Canada mountain"],
  ["America/Los_Angeles", "US and Canada west"],
  ["UTC", "UTC"],
];

function zoneOptions(now = Date.now()) {
  return ZONES.map(([value, label]) => ({
    label,
    value,
    description: `It's ${clock(now, value)} there now`,
  }));
}

module.exports = { zoneOptions };
