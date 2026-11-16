// Server-side Spanish/English. The app sends Accept-Language ("es" or "en");
// browsers send their own. Spanish (Costa Rica) unless English comes first.
//
// - translateErrors: middleware that turns the English { error } messages
//   the routes return into Spanish for Spanish-speaking clients, so the
//   routes themselves stay unchanged.
// - push(): push notification text in the recipient's language.

function pickLang(req) {
  const first = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase().split(',')[0].trim();
  return first.startsWith('en') ? 'en' : 'es';
}

const ERRORS_ES = {
  'Your account has been suspended.': 'Tu cuenta fue suspendida.',
  'Sign in required': 'Tenés que iniciar sesión',
  'Not authorized to move this guest profile': 'No tenés permiso para mover este perfil de invitado',
  'Could not migrate guest data': 'No se pudieron pasar los datos de invitado',
  'Could not delete account data': 'No se pudieron eliminar los datos de la cuenta',
  'Your data was deleted, but the login itself could not be removed — contact support': 'Tus datos se eliminaron, pero no se pudo quitar la cuenta de acceso. Escribinos a soporte',
  'Could not save profile': 'No se pudo guardar el perfil',
  'Could not load availability': 'No se pudo cargar la disponibilidad',
  'Not found': 'No encontrado',
  'No photo received': 'No llegó ninguna foto',
  'That photo is too big': 'Esa foto es demasiado grande',
  'That photo couldn’t be read — try another one': 'No se pudo leer esa foto, probá con otra',
  'Photos aren’t set up yet': 'Las fotos todavía no están activadas',
  'Could not save the photo': 'No se pudo guardar la foto',
  'Could not remove the photo': 'No se pudo quitar la foto',
  'This person has no photo': 'Esta persona no tiene foto',
  'Run supabase-dashboard.sql first': 'Primero corré supabase-dashboard.sql',
  'Could not load the dashboard': 'No se pudo cargar el panel',
  'Only players in this round can answer': 'Solo los jugadores de esta ronda pueden responder',
  'This round hasn’t happened yet': 'Esta ronda todavía no se jugó',
  'Pick players from this round': 'Elegí jugadores de esta ronda',
  'Could not save your answer': 'No se pudo guardar tu respuesta',
  'Could not load rounds': 'No se pudieron cargar las rondas',
  'Could not load tee times': 'No se pudieron cargar las rondas',
  'Missing required fields': 'Faltan datos obligatorios',
  'Could not create tee time': 'No se pudo publicar la ronda',
  'Could not load tee time': 'No se pudo cargar la ronda',
  "You can't request to join this round": 'No podés pedir unirte a esta ronda',
  'Request not found': 'Solicitud no encontrada',
  'Only a pending request can be withdrawn': 'Solo se puede retirar una solicitud pendiente',
  'Only the host can respond to requests': 'Solo el anfitrión puede responder solicitudes',
  'rating must be between 1 and 5': 'La calificación debe ser de 1 a 5',
  'You can only rate players from this round': 'Solo podés calificar a jugadores de esta ronda',
  'Only the host can cancel this round': 'Solo el anfitrión puede cancelar esta ronda',
  'Not authorized for this chat': 'No tenés acceso a este chat',
  'Could not load messages': 'No se pudieron cargar los mensajes',
  'Could not save subscription': 'No se pudieron activar las notificaciones',
  'Could not remove subscription': 'No se pudieron desactivar las notificaciones',
  'Could not load blocked users': 'No se pudo cargar la lista de bloqueados',
  "You can't block yourself": 'No te podés bloquear a vos mismo',
  'Could not block user': 'No se pudo bloquear',
  'Could not unblock user': 'No se pudo desbloquear',
  'reason is required': 'Contanos el motivo',
  'Could not load that message': 'No se pudo cargar ese mensaje',
  'That message no longer exists': 'Ese mensaje ya no existe',
  'Could not load that round': 'No se pudo cargar esa ronda',
  "You can't report yourself": 'No te podés reportar a vos mismo',
  'Could not submit report': 'No se pudo enviar el reporte',
  'Could not load course ratings': 'No se pudieron cargar las calificaciones del campo',
  'Could not save your rating': 'No se pudo guardar tu calificación',
  'Search term must be at least 3 characters': 'Escribí al menos 3 letras para buscar',
  "Course search isn't responding right now. Try again in a minute, or search by course name.": 'La búsqueda de campos no responde ahorita. Intentá en un minuto o buscá por nombre.',
  'Internal server error': 'Error del servidor. Intentá de nuevo',
  'Could not load events': 'No se pudieron cargar los eventos',
  'Could not load event': 'No se pudo cargar el evento',
  'Event not found': 'Evento no encontrado',
  'Tell us which course (at least 3 characters)': 'Decinos en cuál campo (al menos 3 letras)',
  "You've sent a few requests today — thanks! Try again tomorrow.": 'Ya enviaste varias solicitudes hoy. ¡Gracias! Intentá de nuevo mañana.',
  'Could not send your request': 'No se pudo enviar tu solicitud',
  'Only the Foursome owner can do that': 'Solo el dueño de Foursome puede hacer eso',
  'Title is required (up to 120 characters)': 'El título es obligatorio (hasta 120 caracteres)',
  'Course is required': 'El campo de golf es obligatorio',
  'Pick a date and a time': 'Elegí fecha y hora',
  'Pick the course time zone': 'Elegí la zona horaria del campo',
  'Price must be between ₡500 and ₡2,000,000': 'El precio debe estar entre ₡500 y ₡2.000.000',
  'Max players must be between 1 and 500': 'El máximo de jugadores debe estar entre 1 y 500',
  'Cancellation cutoff must be 0–720 hours': 'El plazo de cancelación debe ser de 0 a 720 horas',
  'Description is too long (2,000 characters max)': 'La descripción es muy larga (máximo 2.000 caracteres)',
  'The start time has to be in the future': 'La hora de inicio tiene que ser en el futuro',
  'Could not create the event': 'No se pudo crear el evento',
  'A cancelled event can’t be edited': 'Un evento cancelado no se puede editar',
  'People have already paid, so the price can’t change. Cancel and re-create the event instead.': 'Ya hay personas que pagaron, así que el precio no puede cambiar. Cancelá el evento y crealo de nuevo.',
  'Could not save the event': 'No se pudo guardar el evento',
  'Could not load requests': 'No se pudieron cargar las solicitudes',
  'Payments aren’t available right now. Try again later.': 'Los pagos no están disponibles ahorita. Intentá más tarde.',
  'Create an account or log in to join paid events': 'Creá una cuenta o iniciá sesión para unirte a eventos pagados',
  'Could not hold a spot — try again': 'No se pudo reservar un espacio. Intentá de nuevo',
  'This event is no longer open': 'Este evento ya no está abierto',
  'Sorry — this event just filled up': 'Lo sentimos: este evento se acaba de llenar',
  'Couldn’t open the payment page. Your spot wasn’t held — try again.': 'No se pudo abrir la página de pago. Tu espacio no quedó reservado; intentá de nuevo.',
  'That payment already has a refund under way, or isn’t paid': 'Ese pago ya tiene un reembolso en proceso, o no está pagado',
  'Log in to manage your spot': 'Iniciá sesión para administrar tu espacio',
  'You don’t have a spot in this event': 'No tenés un espacio en este evento',
  'It’s past the cancellation cutoff for this event, so it can’t be refunded': 'Ya pasó el plazo de cancelación de este evento, así que no se puede reembolsar',
  'We couldn’t start your refund — try again, or contact us': 'No pudimos iniciar tu reembolso. Intentá de nuevo o escribinos',
  'Could not load attendees': 'No se pudo cargar la lista de asistentes',
  "That contains language we don't allow — please rephrase and try again.": 'Eso tiene lenguaje que no permitimos. Reformulalo e intentá de nuevo.',
  'Groups aren’t set up yet': 'Los grupos todavía no están activados',
  'This group no longer exists': 'Este grupo ya no existe',
  'Only the group’s creator can do that': 'Solo quien creó el grupo puede hacer eso',
  'Only members can see this': 'Solo los miembros pueden ver esto',
  'Only members can post to this group': 'Solo los miembros pueden publicar en este grupo',
  'Give the group a name (up to 60 characters)': 'Ponele nombre al grupo (hasta 60 caracteres)',
  'Description is too long (300 characters max)': 'La descripción es muy larga (máximo 300 caracteres)',
  'You’ve created the most groups allowed (10)': 'Ya creaste la cantidad máxima de grupos (10)',
  'This invite link no longer works': 'Este enlace de invitación ya no funciona',
  'You can’t join this group': 'No podés unirte a este grupo',
  'You created this group — delete it instead': 'Vos creaste este grupo; podés eliminarlo',
  'You can’t remove yourself': 'No te podés sacar a vos mismo',
  'Pick a day, a time and the number of spots': 'Elegí el día, la hora y la cantidad de espacios',
  'Only the host or the group’s creator can do that': 'Solo el anfitrión o quien creó el grupo puede hacer eso',
  "action must be 'approve', 'deny' or 'remove'": 'Acción no válida',
  'name and text are required': 'Escribí un mensaje',
  'Event extras aren’t set up yet': 'Estas funciones de eventos todavía no están activadas',
  'Group payments and codes aren’t set up yet': 'Los pagos en grupo y los códigos todavía no están activados',
  'You can pay for 1 to 4 spots': 'Podés pagar de 1 a 4 espacios',
  'Add a name for each guest': 'Poné el nombre de cada invitado',
  'There aren’t that many spots left': 'No quedan tantos espacios',
  'That code isn’t valid': 'Ese código no es válido',
  'That code has been used up': 'Ese código ya se agotó',
  'Guest not found': 'Invitado no encontrado',
  'That guest was already refunded': 'A ese invitado ya se le reembolsó',
  'Something changed — try again': 'Algo cambió. Intentá de nuevo',
  'No ONVO payment to refund': 'No hay un pago de ONVO para reembolsar',
  'You already have a spot': 'Ya tenés un espacio',
  'There are spots left — you can pay now': 'Todavía hay espacios: podés pagar ya',
  'Codes are 3–20 letters or numbers': 'Los códigos tienen de 3 a 20 letras o números',
  'A percent discount is 1 to 100': 'Un descuento en porcentaje va de 1 a 100',
  'A fixed discount is ₡100 to ₡2,000,000': 'Un descuento fijo va de ₡100 a ₡2.000.000',
  'Uses must be between 1 and 10,000': 'Los usos deben ser de 1 a 10.000',
  'Pick an expiry date': 'Elegí una fecha de vencimiento',
  'The expiry date has to be in the future': 'La fecha de vencimiento tiene que ser futura',
  'There’s already a code with that name': 'Ya existe un código con ese nombre',
  'You can post results once the event has started': 'Podés publicar resultados cuando el evento ya empezó',
  'Results are too long (4,000 characters max)': 'Los resultados son muy largos (máximo 4.000 caracteres)',
  'That’s the most photos for one event (12)': 'Ese es el máximo de fotos por evento (12)',
  'Friends aren’t set up yet': 'Los amigos todavía no están activados',
  'That’s you': 'Esa persona sos vos',
  'You can’t add this person as a friend': 'No podés agregar a esta persona como amigo',
  'You can add people as friends after playing a round or an event together': 'Podés agregar amigos después de jugar juntos una ronda o un evento',
  "action must be 'add', 'accept', 'decline' or 'remove'": 'Acción no válida',
};

// A few messages with numbers in them.
const ERROR_PATTERNS_ES = [
  [/^(\d+) spots? (?:is|are) already taken, so max players can’t go below that$/, m => `Ya hay ${m[1]} ${m[1] === '1' ? 'espacio ocupado' : 'espacios ocupados'}, así que el máximo no puede ser menor`],
  [/^Refund failed: (.*)$/, m => `El reembolso falló: ${m[1]}`],
];

function translateError(msg, lang) {
  if (lang !== 'es' || typeof msg !== 'string') return msg;
  if (ERRORS_ES[msg]) return ERRORS_ES[msg];
  for (const [re, fn] of ERROR_PATTERNS_ES) {
    const m = msg.match(re);
    if (m) return fn(m);
  }
  return msg;
}

function translateErrors(req, res, next) {
  const lang = pickLang(req);
  req.lang = lang;
  if (lang === 'es') {
    const json = res.json.bind(res);
    res.json = body => {
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        body = { ...body, error: translateError(body.error, lang) };
      }
      return json(body);
    };
  }
  next();
}

// Push notification text: push(lang, 'joinRequest', { name, course }) → [title, body]
const PUSH = {
  joinRequest: {
    en: p => ['New join request', `${p.name} wants to join your round at ${p.course}`],
    es: p => ['Nueva solicitud', `${p.name} quiere unirse a tu ronda en ${p.course}`],
  },
  approved: {
    en: p => ["You're in!", `You're confirmed for the round at ${p.course}`],
    es: p => ['¡Estás dentro!', `Quedaste confirmado para la ronda en ${p.course}`],
  },
  declined: {
    en: p => ['Request update', `Your request for ${p.course} was declined`],
    es: p => ['Actualización de tu solicitud', `Tu solicitud para ${p.course} fue rechazada`],
  },
  roundCancelled: {
    en: p => ['Round cancelled', `The round at ${p.course} on ${p.date} was cancelled by the host.`],
    es: p => ['Ronda cancelada', `El anfitrión canceló la ronda en ${p.course} del ${p.date}.`],
  },
  chat: {
    en: p => [`${p.name} · ${p.course}`, p.preview],
    es: p => [`${p.name} · ${p.course}`, p.preview],
  },
  eventCancelled: {
    en: () => ['Event cancelled', 'An event you paid for was cancelled. Your payment is being refunded in full.'],
    es: () => ['Evento cancelado', 'Se canceló un evento que pagaste. Te estamos reembolsando el monto completo.'],
  },
};

function push(lang, key, params = {}) {
  const entry = PUSH[key];
  return (entry[lang] || entry.es)(params);
}

module.exports = { pickLang, translateError, translateErrors, push };
