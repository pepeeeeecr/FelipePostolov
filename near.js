// Where the player is, for sorting by distance and nearby searches.
// The app sends it in the X-Foursome-Near header ("lat,lng") so it never
// appears in the web address, which hosting request logs record. Older
// app versions send ?lat=&lng= instead; both are accepted. It's used for
// the one request and never stored or logged.
function nearFrom(req) {
  let lat, lng;
  const header = req.get ? req.get('X-Foursome-Near') : (req.headers || {})['x-foursome-near'];
  if (header) [lat, lng] = String(header).split(',').map(s => parseFloat(s));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = parseFloat((req.query || {}).lat);
    lng = parseFloat((req.query || {}).lng);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

module.exports = { nearFrom };
