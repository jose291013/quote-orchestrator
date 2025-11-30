require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const crypto = require('crypto');
const PJM_BASE_URL = process.env.PJM_BASE_URL;
const PJM_USERNAME = process.env.PJM_USERNAME;
const PJM_PASSWORD = process.env.PJM_PASSWORD;

const DEBUG_MATCHING = true; // passe à false en prod pour calmer les logs


console.log('=== BLACKTOWN ORCHESTRATOR INDEX.JS v1.0.3 ===');


let pjmAuthCache = {
  token: null,
  expiresAt: null
};

// Store en mémoire pour les sessions (V1 simple, à remplacer plus tard par une vraie DB)
const sessions = {}; // { [token]: { productTypeId, aiResult, missingFields, lowConfidenceFields, createdAt } }


// === Chargement des configs JSON ===
const productsRaw = require('./config/products.json');
const requestFields = require('./config/requestFields.json');
const fieldProfiles = require('./config/fieldProfiles.json');

// Normalisation des produits (keywords en tableau, booléens, etc.)
const products = productsRaw.map(p => ({
  ...p,
  is_preprinted: String(p.is_preprinted).toUpperCase() === 'TRUE',
  keywords: (p.keywords || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
}));

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => { ... });

// === OpenAI client ===
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Petit seuil de confiance
const CONFIDENCE_MIN = 0.75;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


// Route de test
app.get('/', (req, res) => {
  res.send('Blacktown Quote Orchestrator API is running');
});

/**
 * Choisit le meilleur produit à partir de aiResult
 * puis calcule les champs manquants à partir des profils.
 */
function mapAiResultToProduct(aiResult) {
  if (!aiResult) {
    return {
      productTypeId: null,
      missingFields: [],
      lowConfidenceFields: []
    };
  }

  /**
 * Endpoint minimal pour Albato :
 *  - reçoit un email
 *  - IA pour classifier et extraire
 *  - si ce n'est PAS un devis → ROUTE_TO_HUMAN
 *  - si c'est un devis → NEED_COMPLETION_FORM + lien /form/:token
 */
app.post('/incoming-email', async (req, res) => {
  try {
    // Payload qu’on attend depuis Albato
    const {
      subject = '',
      body = '',
      fromEmail = null,
      fromName = null
    } = req.body || {};

    const requesterEmail = fromEmail;
    const requesterName = fromName;

    console.log('📩 /incoming-email received:');
    console.log('  subject:', subject);
    console.log('  fromEmail:', requesterEmail);
    console.log('  fromName:', requesterName);

    // 1) Appel IA
    const aiResult = await callAiForEmail(
      subject,
      body,
      requesterEmail,
      requesterName
    );

    console.log('🤖 AI result (incoming-email):', JSON.stringify(aiResult, null, 2));

    // 2) Si l'IA dit que ce n'est PAS une demande de devis → on renvoie vers un humain
    const isPrintRequest = aiResult?.is_print_request;
    const classification = aiResult?.classification; // "QUOTE_REQUEST" | "OTHER"

    if (!isPrintRequest || classification !== 'QUOTE_REQUEST') {
      return res.json({
        action: 'FORWARD_TO_HUMAN',
        reason: 'Email is not a quote request according to AI',
        classification: classification || 'UNKNOWN',
        is_print_request: !!isPrintRequest,
        // Albato utilisera ces infos pour router vers une boîte humaine
        suggestedForwardTo: 'printroom@yourdomain.com'
      });
    }

    // 3) On mappe vers un produit PJM + champs manquants
    const {
      productTypeId,
      missingFields,
      lowConfidenceFields
    } = mapAiResultToProduct(aiResult);

    // Si l’IA n’a pas trouvé de produit fiable → on renvoie aussi vers un humain
    if (!productTypeId) {
      return res.json({
        action: 'FORWARD_TO_HUMAN',
        reason: 'No reliable product_type_id found by AI',
        is_print_request: true,
        classification: classification || 'QUOTE_REQUEST',
        suggestedForwardTo: 'printroom@yourdomain.com'
      });
    }

    // 4) On crée un token de session
    const token = crypto.randomBytes(16).toString('hex');

    // 5) On stocke ce qu’il faut pour le wizard /form/:token
    sessions[token] = {
      productTypeId,
      aiResult,
      missingFields,
      lowConfidenceFields,
      requesterEmail,
      requesterName,
      createdAt: new Date().toISOString()
    };

    // 6) Construction de l’URL du formulaire (Render)
    const baseUrl =
      process.env.PUBLIC_BASE_URL || 'http://localhost:4000';

    const formUrl = `${baseUrl.replace(/\/+$/, '')}/form/${token}`;

    // 7) Réponse JSON pour Albato
    return res.json({
      action: 'NEED_COMPLETION_FORM',
      productTypeId,
      missingFields,
      token,
      formUrl
    });
  } catch (err) {
    console.error('Error in /incoming-email:', err);
    return res
      .status(500)
      .json({ error: 'Internal error in /incoming-email' });
  }
});


  // Liste de candidats envoyée par l'IA
  const candidates = aiResult.product_candidates || [];
  const bestProduct = candidates[0];

  if (!bestProduct || !bestProduct.product_type_id) {
    // Aucun produit fiable → on laisse la main à un humain
    return {
      productTypeId: null,
      missingFields: [],
      lowConfidenceFields: []
    };
  }

  const productTypeId = bestProduct.product_type_id;

  // On réutilise ta fonction existante pour savoir
  // quels champs sont manquants / faible confiance
  const { missingFields, lowConfidenceFields } = computeMissingFields(
    aiResult,
    productTypeId,
    products,
    fieldProfiles
  );

  return { productTypeId, missingFields, lowConfidenceFields };
}

/**
 * 1) Endpoint appelé par Albato (ou Postman pour tester)
 *    -> reçoit un email
 *    -> IA pour extraire infos
 *    -> calcule les champs manquants
 */
app.post('/webhook/email', async (req, res) => {
  try {
    // ✅ On récupère ce que Postman / Albato envoie
    const {
      subject = '',
      body = '',
      fromEmail = null,
      fromName = null
    } = req.body || {};

    // Email + nom de la personne qui a envoyé la demande
    const requesterEmail = fromEmail;
    const requesterName = fromName;

    console.log('📩 /webhook/email received:');
    console.log('  subject:', subject);
    console.log('  fromEmail:', requesterEmail);
    console.log('  fromName:', requesterName);

    // 🔹 Appel à l’IA (signature simple et claire)
    const aiResult = await callAiForEmail(
      subject,
      body,
      requesterEmail,
      requesterName
    );

    // 🔹 Mapping IA -> produit + champs manquants
    const { productTypeId, missingFields } = mapAiResultToProduct(aiResult);

    // 🔹 Token de session
    const token = crypto.randomBytes(16).toString('hex');

    // 🔹 On stocke tout ce qui servira plus tard (formulaire + PJM)
    sessions[token] = {
      productTypeId,
      aiResult,
      missingFields,
      requesterEmail,
      requesterName,
      createdAt: new Date().toISOString()
    };

    // 🔹 Réponse à Albato / Postman
    return res.json({
      action: 'NEED_COMPLETION_FORM',
      productTypeId,
      missingFields,
      token,
      formUrl: `http://localhost:4000/form/${token}`
    });
  } catch (err) {
    console.error('Error in /webhook/email', err);
    return res
      .status(500)
      .json({ error: 'Internal error in /webhook/email' });
  }
});



/**
 * 2) Fonction d’appel IA : lit l’email et renvoie un JSON structuré
 */
/**
 * 2) Fonction d’appel IA : lit l’email et renvoie un JSON structuré
 */
async function callAiForEmail(subject, body, fromEmail, fromName) {
  const systemPrompt = `
You are an assistant that reads internal print job request emails
and extracts structured data for a local government print room.

You MUST return ONLY valid JSON, no explanations.

JSON structure:
{
  "is_print_request": boolean,
  "classification": "QUOTE_REQUEST" | "OTHER",
  "product_candidates": [
    { "product_type_id": string, "score": number }
  ],
  "fields": {
    "<field_id>": { "value": any, "confidence": number }
  }
}

- "product_type_id" must be chosen from the list provided.
- "fields" keys must match the field_id from the requestFields list I will give you.
- If it is not a print job / quote request, set is_print_request=false
  and product_candidates = [].
- Do NOT include any text before or after the JSON. No commentary, no markdown.
`;

  const productsListForAi = products.map(p => ({
    product_type_id: p.product_type_id,
    label: p.label,
    keywords: p.keywords
  }));

  const userPrompt = `
EMAIL FROM: ${fromName || ''} <${fromEmail || ''}>
SUBJECT: ${subject}

TEXT:
${body}

Here is the list of product types (id, label, keywords):
${JSON.stringify(productsListForAi, null, 2)}

Here is the list of known fields (field_id only):
${JSON.stringify(requestFields.map(f => f.field_id), null, 2)}
`;

  const completion = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
    // pas de response_format, pas de text.format
  });

  const firstOutput = completion.output[0];
  const contentItem =
    firstOutput.content.find(c => c.type === 'output_text') ||
    firstOutput.content[0];

  if (!contentItem || !contentItem.text) {
    throw new Error('No text output from OpenAI');
  }

  const jsonText = contentItem.text;
  const aiResult = JSON.parse(jsonText);

  return aiResult;
}




function generateToken() {
  return crypto.randomBytes(16).toString('hex'); // token simple de 32 caractères
}


/**
 * 3) Calcul des champs manquants à partir du profil
 */
function computeMissingFields(aiResult, productTypeId, productsTable, profilesTable) {
  const productRow = productsTable.find(p => p.product_type_id === productTypeId);
  if (!productRow) {
    throw new Error('Unknown product_type_id: ' + productTypeId);
  }

  const profileId = productRow.required_fields_profile;
  const profileRow = profilesTable.find(p => p.profile_id === profileId);
  if (!profileRow) {
    throw new Error('Unknown profile_id: ' + profileId);
  }

  const requiredFieldIds = (profileRow.required_fields || '')
    .split('|')
    .filter(Boolean);

  const missingFields = [];
  const lowConfidenceFields = [];

  for (const fieldId of requiredFieldIds) {
    const fieldData = aiResult.fields?.[fieldId];

    if (!fieldData || fieldData.value === null || fieldData.value === '') {
      // Pas de valeur → clairement manquant
      missingFields.push(fieldId);
    } else if (
      typeof fieldData.confidence === 'number' &&
      fieldData.confidence < CONFIDENCE_MIN
    ) {
      // L’IA propose quelque chose mais pas assez sûr
      lowConfidenceFields.push({
        field_id: fieldId,
        suggested_value: fieldData.value,
        confidence: fieldData.confidence
      });
    }
  }

  return { missingFields, lowConfidenceFields };
}

function buildInitialEngineSelectionsFromAi(aiResult, pjmOptions) {
  const selections = {};
  const aiFields = (aiResult && aiResult.fields) || {};
  const opts = (pjmOptions && pjmOptions.Options) || [];

  // Exemple : champ IA "quantity"
  const qtyField = aiFields.quantity;
  if (qtyField && qtyField.value != null) {
    const qtyValue = String(qtyField.value);

    // On cherche l’option PJM "Quantité d'exemplaires" (ou similaire)
    const qtyOpt = opts.find((o) => {
      const label = (o.Label || '').toLowerCase();
      return (
        label.includes("quantité d'exemplaires") ||
        label.includes('quantité') ||
        label.includes('quantity')
      );
    });

    if (qtyOpt) {
      selections[qtyOpt.Id] = qtyValue;
      console.log(
        '[INIT] IA quantity -> PJM option',
        qtyOpt.Id,
        '=',
        qtyValue
      );
    }
  }

  // Tu pourras plus tard ajouter d’autres mappings (nb pages, couleur, etc.)

  return selections;
}

// === Génération d'un formulaire HTML simple à partir des requestFields ===

function renderFieldHtml(field) {
  const id = field.field_id;
  const label = field.label_on_form;
  const requiredAttr = field.is_required_global ? 'required' : '';

  switch (field.data_type) {
    case 'string':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="text" id="${id}" name="${id}" ${requiredAttr} style="width:100%;padding:6px;">
      </div>
      `;
    case 'int':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="number" id="${id}" name="${id}" ${requiredAttr} style="width:100%;padding:6px;">
      </div>
      `;
    case 'date':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="date" id="${id}" name="${id}" ${requiredAttr} style="padding:6px;">
      </div>
      `;
    case 'text':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <textarea id="${id}" name="${id}" ${requiredAttr} rows="4" style="width:100%;padding:6px;"></textarea>
      </div>
      `;
    case 'enum': {
      const options = (field.allowed_values || '')
        .split('|')
        .filter(Boolean);
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <select id="${id}" name="${id}" ${requiredAttr} style="width:100%;padding:6px;">
          <option value="">Please select…</option>
          ${options.map(o => `<option value="${o}">${o}</option>`).join('')}
        </select>
      </div>
      `;
    }
    case 'bool':
      return `
      <div style="margin-bottom: 12px;">
        <label>
          <input type="checkbox" name="${id}" value="true">
          ${label}
        </label>
      </div>
      `;
    default:
      return '';
  }
}

function renderFieldHtmlWithValue(field, value) {
  const id = field.field_id;
  const label = field.label_on_form;
  const requiredAttr = field.is_required_global ? 'required' : '';
  const safeValue = value == null ? '' : String(value);

  switch (field.data_type) {
    case 'string':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="text" id="${id}" name="${id}" value="${safeValue}" ${requiredAttr} style="width:100%;padding:6px;">
      </div>
      `;
    case 'int':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="number" id="${id}" name="${id}" value="${safeValue}" ${requiredAttr} style="width:100%;padding:6px;">
      </div>
      `;
    case 'date':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <input type="date" id="${id}" name="${id}" value="${safeValue}" ${requiredAttr} style="padding:6px;">
      </div>
      `;
    case 'text':
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <textarea id="${id}" name="${id}" ${requiredAttr} rows="4" style="width:100%;padding:6px;">${safeValue}</textarea>
      </div>
      `;
    case 'enum': {
      const options = (field.allowed_values || '')
        .split('|')
        .filter(Boolean);
      return `
      <div style="margin-bottom: 12px;">
        <label for="${id}" style="display:block;margin-bottom:4px;">${label}</label>
        <select id="${id}" name="${id}" ${requiredAttr} style="width:100%;padding:6px;">
          <option value="">Please select…</option>
          ${options
            .map(
              o =>
                `<option value="${o}" ${
                  o === safeValue ? 'selected' : ''
                }>${o}</option>`
            )
            .join('')}
        </select>
      </div>
      `;
    }
    case 'bool':
      return `
      <div style="margin-bottom: 12px;">
        <label>
          <input type="checkbox" name="${id}" value="true" ${
            safeValue === 'true' ? 'checked' : ''
          }>
          ${label}
        </label>
      </div>
      `;
    default:
      return '';
  }
}

/**
 * Formulaire de test pour compléter les champs manquants.
 * Exemple: http://localhost:4000/debug/form?fields=job_title,department_code
 */
app.get('/debug/form', (req, res) => {
  const fieldsParam = req.query.fields || '';
  const fieldIds = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);

  const selectedFields = requestFields.filter(f => fieldIds.includes(f.field_id));

  let html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Complete your print job request</title>
    </head>
    <body style="
  font-family: Arial, sans-serif;
  max-width: 900px;
  margin: 24px auto;
  padding: 24px 32px;
  font-size: 16px;
  line-height: 1.6;
  color: #0f172a;
  background: #f9fafb;
  border-radius: 12px;
  box-shadow: 0 10px 25px rgba(15, 23, 42, 0.08);
">

      <h1 style="font-size:24px; margin-bottom:8px;">Request completed</h1>
<p style="margin-top:0; margin-bottom:16px; color:#475569;">Please fill in the missing information to finalise your quote request.</p>
      <form method="POST" action="/debug/form/submit">
  `;

  for (const field of selectedFields) {
    html += renderFieldHtml(field);
  }

  html += `
        <button type="submit" style="padding:8px 16px;">Submit</button>
      </form>
    </body>
  </html>
  `;

  res.send(html);
});
/**
 * Découpe les options PJM en :
 *  - doneOptions : ont déjà une valeur dans engineSelections
 *  - pendingOptions : encore sans valeur
 */
function splitPjmOptionsForWizard(pjmResponse, engineSelections) {
  const selections = engineSelections || {};
  const allOptions = (pjmResponse && pjmResponse.Options) || [];

  const doneOptions = [];
  const pendingOptions = [];

  for (const opt of allOptions) {
    const currentValue =
      selections[opt.Id] === undefined || selections[opt.Id] === null
        ? ''
        : String(selections[opt.Id]);

    const enriched = {
      ...opt,
      selectedValue: currentValue || null
    };

    if (currentValue && currentValue !== '') {
      doneOptions.push(enriched);
    } else {
      pendingOptions.push(enriched);
    }
  }

  return { doneOptions, pendingOptions };
}

/**
 * Transforme une option PJM en "field" simplifié pour le front
 */
function mapPjmOptionToField(opt, engineSelections) {
  const selections = engineSelections || {};
  const selected = selections[opt.Id];
  const settings = opt.Settings || [];
  const defaultSetting = settings.find((s) => s.Key === 'default');

  const defaultValue =
    selected != null && selected !== ''
      ? String(selected)
      : defaultSetting && defaultSetting.Value != null
      ? String(defaultSetting.Value)
      : '';

  return {
    id: opt.Id,
    label: opt.Label,
    type: inferPjmFieldType(opt),
    options: (opt.Options || []).map((o) => ({
      key: o.Key,
      value: o.Value
    })),
    defaultValue,
    selectedValue: selected != null ? String(selected) : null
  };
}


app.post('/pjm/next-option/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const session = sessions[token];
    if (!session) {
      return res.status(404).json({ error: 'Unknown session token' });
    }

    const productTypeId = session.productTypeId;
    const productRow = products.find(
      (p) => p.product_type_id === productTypeId
    );
    if (!productRow || !productRow.pjm_engine_integration_id) {
      return res
        .status(400)
        .json({ error: 'No PJM engine for this product type' });
    }

    // 🔹 On FUSIONNE ce que le front envoie avec ce qu'on a déjà en session
const engineSelectionsFromBody = req.body.engineSelections || {};
session.engineSelections = {
  ...(session.engineSelections || {}),
  ...engineSelectionsFromBody
};

const engineId = productRow.pjm_engine_integration_id;

// Construire Options[] à partir des sélections actuelles (format { Key, Value })
const optionsArray = buildPjmOptionsFromSelections(
  session.engineSelections,
  session.pjmOptions
);


    // Appel PJM pour rafraîchir les options
    const refreshed = await callPjmEngine('options', engineId, optionsArray);
    session.pjmOptions = refreshed; // on garde la dernière structure

    const allOpts = refreshed.Options || [];
    const allowedIds = allOpts.map((o) => o.Id);
    const totalOptions = allOpts.length;

    // 🔹 Découper en "déjà répondues" + "encore à compléter"
    const { doneOptions, pendingOptions } = splitPjmOptionsForWizard(
      refreshed,
      session.engineSelections
    );

    const doneFields = doneOptions.map((opt) =>
      mapPjmOptionToField(opt, session.engineSelections)
    );

    const nextOpt = pendingOptions.length > 0 ? pendingOptions[0] : null;
    const nextField = nextOpt
      ? mapPjmOptionToField(nextOpt, session.engineSelections)
      : null;

    return res.json({
      done: !nextField,
      allowedIds,
      doneOptions: doneFields,
      totalOptions,
      nextField
    });
  } catch (err) {
    console.error('Error in /pjm/next-option:', err);
    res.status(500).json({ error: 'next-option error' });
  }
});





// pour l'instant on juste log le résultat du POST
app.post('/debug/form/submit', express.urlencoded({ extended: true }), (req, res) => {
  console.log('Form submitted:', req.body);
  res.send('<p>Thanks! Form submitted. (Check server logs)</p>');
});

function inferPjmFieldType(pjmOption) {
  if (!pjmOption) return 'text';

  const opts = pjmOption.Options || [];
  const optsCount = opts.length;
  const label = (pjmOption.Label || '').toLowerCase();
  const settings = pjmOption.Settings || [];
  const controlSetting = settings.find(
    (s) => s.Key && s.Key.toLowerCase() === 'control'
  );

  // 1) CAS GÉNÉRAL : s'il y a AU MOINS une option → on considère que c'est un select
  //    (ex : quantité 250/500/750 pour les cartes de visite)
  if (optsCount > 0) {
    return 'select';
  }

  // 2) AUCUNE option fournie par PJM → champ libre

  // 2a) Si PJM indique un contrôle numérique -> number
  if (
    controlSetting &&
    controlSetting.Value &&
    controlSetting.Value.toLowerCase().includes('numeric')
  ) {
    return 'number';
  }

  // 2b) Cas spécifique : "Quantité d'exemplaires" sans Options => number
  if (label.includes("quantité d'exemplaires")) {
    return 'number';
  }

  // 2c) Sinon : texte libre
  return 'text';
}



/**
 * Formulaire réel basé sur un token de session.
 * URL type : http://localhost:4000/form/<token>
 */
// === Formulaire réel basé sur un token de session (version "wizard" PJM) ===
app.get('/form/:token', async (req, res) => {
  const token = req.params.token;

  const session = sessions[token];
  if (!session) {
    return res.status(404).send('Unknown or expired token');
  }

  const { productTypeId, aiResult, missingFields = [] } = session;

  // Données du demandeur (stockées dans la session au moment du webhook)
  const requesterEmail = session.requesterEmail || '';
  const requesterName = session.requesterName || '';

  let defaultRecipientFirstName = '';
  let defaultRecipientLastName = '';

  if (requesterName) {
    const split = splitName(requesterName);
    defaultRecipientFirstName = split.firstName;
    defaultRecipientLastName = split.lastName;
  }

  // Récupérer la ligne produit dans products.json
  const productRow = products.find(
    (p) => p.product_type_id === productTypeId
  );
  if (!productRow) {
    return res
      .status(500)
      .send(`Unknown product_type_id in products.json: ${productTypeId}`);
  }

  // 1) Récupérer / réutiliser les options PJM pour ce moteur
  let pjmOptions = session.pjmOptions || null;
  try {
    if (!pjmOptions) {
      pjmOptions = await getPjmEngineOptionsForProduct(productRow);
      session.pjmOptions = pjmOptions;
    }
  } catch (err) {
    console.error('❌ Could not fetch PJM options for form:', err.message);
  }
    // 1b) Pré-remplir les sélections PJM à partir de l'IA (une seule fois)
  if (!session.engineSelections || Object.keys(session.engineSelections).length === 0) {
    session.engineSelections = buildInitialEngineSelectionsFromAi(
      aiResult,
      pjmOptions
    );
    console.log('🔧 Initial engineSelections from AI:', session.engineSelections);
  }


  const aiFields = (aiResult && aiResult.fields) || {};

  // 2) Valeurs IA par défaut pour les champs texte
  const jobTitleFromAi =
    aiFields.job_title && aiFields.job_title.value
      ? aiFields.job_title.value
      : '';
  const deptCodeFromAi =
    aiFields.department_code && aiFields.department_code.value
      ? aiFields.department_code.value
      : '';
        // Requested date / deadline pré-remplie si trouvée par l'IA
  const deadlineFromAi =
    aiFields.deadline_date && aiFields.deadline_date.value
      ? aiFields.deadline_date.value  // idéalement au format YYYY-MM-DD
      : '';


  // 3) Récupérer la liste d'organisations PJM pour le datalist
  let orgOptionsHtml = '';
  try {
    const orgs = await getPjmOrganizationsList('', 200, 0);
    orgOptionsHtml = orgs
      .map((o) => `<option value="${escapeHtml(o.name)}"></option>`)
      .join('');
  } catch (err) {
    console.error(
      '❌ Could not fetch PJM organizations list:',
      err.message
    );
  }

  // Liste des champs manquants (info)
  const missingListHtml =
    missingFields && missingFields.length
      ? `<ul>${missingFields
          .map((f) => `<li>${escapeHtml(f)}</li>`)
          .join('')}</ul>`
      : '<p>All fields detected, you can review or adjust options.</p>';

    // 4) Réponse HTML (wizard pour PJM, UI améliorée)
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Complete your quote request</title>
        <style>
  :root {
    --bg: #020617;
    --card-bg: #ffffff;
    --accent: #2563eb;
    --accent-soft: rgba(37, 99, 235, 0.08);
    --border-subtle: #e5e7eb;
    --text-main: #0f172a;
    --text-muted: #6b7280;
    --radius-lg: 18px;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 24px 12px 32px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    background: radial-gradient(circle at top, #1e293b 0, #020617 55%);
    color: var(--text-main);
    font-size: 15px;
    line-height: 1.6;
  }

  .page {
    max-width: 1040px;
    margin: 0 auto;
  }

  .page-header {
    color: #e5e7eb;
    margin-bottom: 18px;
  }

  .page-header h1 {
    margin: 0 0 8px 0;
    font-size: 24px;
    font-weight: 650;
  }

  .page-header p {
    margin: 0;
    font-size: 14px;
    color: #cbd5f5;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font-size: 11px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(148, 163, 184, 0.5);
    margin-bottom: 10px;
  }

  .pill-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #22c55e;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.3fr);
    gap: 18px;
  }

  /* ➜ Sur tablette / mobile : 1 seule colonne */
  @media (max-width: 960px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .card {
    background: var(--card-bg);
    border-radius: var(--radius-lg);
    padding: 20px 18px 22px;
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.45);
    border: 1px solid rgba(148, 163, 184, 0.35);
  }

  .card h2 {
    margin: 0 0 4px;
    font-size: 18px;
  }

  .card-sub {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text-muted);
  }

  .section-title {
    margin-top: 16px;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }

  .field {
    margin-bottom: 12px;
  }

  .field-label {
    font-size: 14px;
    font-weight: 650;
    margin-bottom: 6px;
    color: #0f172a;
  }

  .field-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 3px;
  }

  /* ✅ Inputs & selects modernes (y compris pour les options PJM) */
  input[type="text"],
  input[type="email"],
  input[type="number"],
  select {
    width: 100%;
    border-radius: 999px;
    border: 1px solid #cbd5e1;
    padding: 10px 14px;
    font-size: 14px;
    background: #ffffff;
    color: #0f172a;
    appearance: none;
    -webkit-appearance: none;
  }

  input[type="text"]:focus,
  input[type="email"]:focus,
  input[type="number"]:focus,
  select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.35);
    background: #f9fafb;
    outline: none;
  }

  /* Petite flèche custom pour les selects */
  select {
    background-image: url("data:image/svg+xml,%3Csvg width='14' height='10' viewBox='0 0 14 10' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M2 2l5 6 5-6' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 14px center;
    background-size: 14px 10px;
    padding-right: 34px;
  }

  .wizard-intro {
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Zone des options PJM = pile de cartes animées */
  #pjm-dynamic-fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .option-wrapper {
    border-radius: 16px;
    padding: 10px 12px 12px;
    background: #f9fafb;
    border: 1px solid #e2e8f0;
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.06);
    animation: optionFadeUp 220ms ease-out;
  }

  @keyframes optionFadeUp {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Bouton principal moderne */
  #btnSubmit {
    border-radius: 999px;
    padding: 10px 20px;
    font-size: 14px;
    font-weight: 600;
    border: none;
    background: linear-gradient(135deg, #2563eb, #22c55e);
    color: #ffffff;
    box-shadow: 0 14px 30px rgba(37, 99, 235, 0.5);
    cursor: pointer;
    transition: transform 0.12s ease, box-shadow 0.12s ease,
      opacity 0.12s ease;
    width: 100%;
    margin-top: 14px;
  }

  #btnSubmit:disabled {
    opacity: 0.4;
    cursor: default;
    box-shadow: none;
  }

  #btnSubmit:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: 0 18px 40px rgba(37, 99, 235, 0.6);
  }

  .side-card-section {
    margin-bottom: 16px;
  }

  .side-card-section h3 {
    margin: 0 0 4px;
    font-size: 14px;
  }

  .side-card-section p {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .tag-list {
    margin-top: 8px;
    font-size: 12px;
  }

  .tag-list ul {
    margin: 0;
    padding-left: 18px;
    color: var(--text-muted);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--accent-soft);
    font-size: 11px;
    color: #1d4ed8;
    margin-top: 6px;
  }

  .product-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.65);
    font-size: 11px;
    color: #e5e7eb;
  }

  .product-pill span {
    max-width: 230px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Bannière pleine largeur en bas */
  .bottom-banner {
    margin-top: 26px;
    position: relative;
    left: 50%;
    right: 50%;
    margin-left: -50vw;
    margin-right: -50vw;
    width: 100vw;
    padding: 24px 16px 32px;
    background: radial-gradient(circle at top, #1d4ed8 0, #020617 55%);
    color: #e5e7eb;
  }

  .bottom-banner-inner {
    max-width: 960px;
    margin: 0 auto;
  }

  .bottom-banner h2 {
    margin: 0 0 6px;
    font-size: 20px;
  }

  .bottom-banner p {
    margin: 0;
    font-size: 13px;
    color: #cbd5f5;
  }

  /* Sur petit écran : cartes moins “massives” */
  @media (max-width: 640px) {
    body {
      padding: 16px 10px 24px;
    }
    .card {
      padding: 16px 14px 18px;
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.4);
    }
  }

  /* === Barre de progression du wizard === */
.wizard-progress {
  margin: 6px 0 8px;
}

.wizard-progress-header {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.wizard-progress-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: #e5e7eb;      /* fond gris clair */
  overflow: hidden;
}

.wizard-progress-fill {
  height: 100%;
  width: 0%;                /* sera mis à jour en JS */
  border-radius: inherit;
  background: linear-gradient(90deg, #2563eb, #22c55e);
  transition: width 0.2s ease-out;
}

/* Variante compacte quand la barre est à côté du bouton */
.wizard-progress--inline {
  flex: 1 1 auto;
  min-width: 0;
}

/* Footer du wizard + bouton sticky sur mobile */
.wizard-footer {
  margin-top: 10px;
}

.sticky-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

@media (min-width: 769px) {
  .sticky-actions {
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  #btnSubmit {
    width: auto;
    min-width: 220px;
  }
}

@media (max-width: 768px) {
  .sticky-actions {
    position: sticky;
    bottom: 0;
    padding-top: 8px;
    margin-left: -4px;
    margin-right: -4px;
    background: linear-gradient(
      to top,
      rgba(248, 250, 252, 0.95),
      rgba(248, 250, 252, 0)
    );
  }

  #btnSubmit {
    width: 100%;
  }
}

    /* === Footer de page === */
.page-footer {
  margin-top: 24px;
  padding: 24px 16px 80px; /* le 80px donne du "rab" pour le scroll */
  background: #020617;
  color: #9ca3af;
  font-size: 12px;
}

.page-footer-inner {
  max-width: 1040px;
  margin: 0 auto;
  border-top: 1px solid rgba(148, 163, 184, 0.4);
  padding-top: 14px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}

.page-footer a {
  color: #cbd5f5;
  text-decoration: none;
}

.page-footer a:hover {
  text-decoration: underline;
}

/* Sur mobile on compacte un peu */
@media (max-width: 640px) {
  .page-footer {
    padding: 20px 12px 90px;
  }
  .page-footer-inner {
    flex-direction: column;
    align-items: flex-start;
  }
}

</style>


        <script>
          // Token pour le wizard PJM
          window.BTO_TOKEN = "${escapeHtml(token)}";
        </script>
      </head>

      <body>
        <div class="page">
          <header class="page-header">
            <div class="pill">
              <span class="pill-dot"></span>
              <span>Email → Quote assistant</span>
            </div>
            <h1>Complete your quote request</h1>
            <p>
              We analysed your email and pre-filled some fields.
              Please review the details and confirm the print options.
            </p>
          </header>

          <div style="margin-bottom:14px;">
            <div class="product-pill">
              <span>Product type</span>
              <span>•</span>
              <span>${escapeHtml(productTypeId)}</span>
            </div>
          </div>

          <main class="layout">
            <!-- Colonne principale : formulaire -->
            <section class="card">
              <h2>Request details</h2>
              <p class="card-sub">
                Check the job title, department and recipient information,
                then answer the print options from PJM.
              </p>

              <form method="POST">
                <!-- Job title -->
                <div class="section-title">Job information</div>

                <div class="field">
                  <div class="field-label">Job title</div>
                  <input
                    type="text"
                    name="job_title"
                    value="${escapeHtml(jobTitleFromAi)}"
                    placeholder="e.g. Annual brochure 16 pages A4"
                  />
                </div>

                <!-- Department / organisation -->
<div class="field">
  <div class="field-label">Department code / organisation</div>
  <input
    type="text"
    name="department_code"
    list="orgList"
    value="${escapeHtml(deptCodeFromAi)}"
    placeholder="Start typing to search..."
  />
  <datalist id="orgList">
    ${orgOptionsHtml}
  </datalist>
  <div class="field-hint">
    Start typing to see matching organisations from PJM.
  </div>
</div>

<!-- Requested date / deadline -->
<div class="field">
  <div class="field-label">Requested date / deadline</div>
  <input
    type="date"
    name="deadline_date"
    lang="en-GB"
    value="${escapeHtml(deadlineFromAi)}"
  />
  <div class="field-hint">
    Optional. Select the requested delivery date if it is important.
  </div>
</div>

<!-- Recipient -->
<div class="section-title">Recipient of the estimate</div>


                <div class="field">
                  <div class="field-label">Recipient first name</div>
                  <input
                    type="text"
                    name="recipient_first_name"
                    value="${escapeHtml(defaultRecipientFirstName)}"
                  />
                </div>

                <div class="field">
                  <div class="field-label">Recipient last name</div>
                  <input
                    type="text"
                    name="recipient_last_name"
                    value="${escapeHtml(defaultRecipientLastName)}"
                  />
                </div>

                <p class="field-hint">
                  The estimate will be sent to the contact using the email from the original request:
                  <strong>${escapeHtml(requesterEmail || 'unknown')}</strong>
                </p>

                <!-- Options PJM -->
                <div class="section-title">Print options (wizard)</div>
                <p class="wizard-intro">
  You will see one print option at a time. When an option is already filled
  from your email, we show it directly and automatically jump to the next question.
</p>



<!-- Zone dynamique PJM -->
<div id="pjm-dynamic-fields"></div>

<div class="wizard-footer">
  <div class="sticky-actions">
    <div class="wizard-progress wizard-progress--inline">
      <div class="wizard-progress-header">
        <span id="wizard-progress-text">0 of 0 options confirmed</span>
      </div>
      <div class="wizard-progress-bar">
        <div
          class="wizard-progress-fill"
          id="wizard-progress-fill"
        ></div>
      </div>
    </div>

    <button id="btnSubmit" type="submit" disabled>
      Confirm and get quote
    </button>
  </div>
</div>


              </form>
            </section>

            <!-- Colonne de droite : résumé & champs manquants -->
            <aside class="card">
              <h2>What we detected</h2>
              <p class="card-sub">
                Quick overview of the information extracted from your email
                and the fields that still need confirmation.
              </p>

              <div class="side-card-section">
                <h3>Fields to confirm / complete</h3>
                <div class="tag-list">
                  ${missingListHtml}
                </div>
              </div>

              <div class="side-card-section">
                <h3>Tip</h3>
                <p>
                  If some options are already correct (quantity, page count, etc.),
                  you don’t need to change them — just move on to the next questions.
                </p>
                <div class="chip">
                  The wizard always shows the next unanswered option.
                </div>
              </div>
            </aside>
          </main>
        </div>

                <!-- Script du wizard PJM : wizard + progress bar + scroll fin -->
        <script>
          (function () {
            var token = window.BTO_TOKEN;
            if (!token) return;

            var form = document.querySelector('form');
            var dynamicZone = document.getElementById('pjm-dynamic-fields');
            var submitBtn = document.getElementById('btnSubmit');
            var progressText = document.getElementById('wizard-progress-text');
            var progressFill = document.getElementById('wizard-progress-fill');

            if (!form || !dynamicZone || !submitBtn) return;

            // Map { optionId: value }
            var engineSelections = {};

            function updateProgress(doneCount, totalCount) {
              if (!progressText || !progressFill || !totalCount) return;
              if (doneCount < 0) doneCount = 0;
              if (doneCount > totalCount) doneCount = totalCount;

              progressText.textContent =
                doneCount + ' of ' + totalCount + ' options confirmed';

              var pct = (doneCount / totalCount) * 100;
              progressFill.style.width = pct + '%';
            }

            function collectSelections() {
              engineSelections = {};
              var inputs = dynamicZone.querySelectorAll('[data-engine-id]');

              inputs.forEach(function (el) {
                var id = el.getAttribute('data-engine-id');
                if (!id) return;
                var val = el.value;
                if (val === '' || val == null) return;
                engineSelections[id] = val;
              });
            }

            function removeFieldsNotAllowed(allowedIds) {
              if (!allowedIds || !allowedIds.length) return;
              var allowed = new Set(allowedIds);
              var wrappers = dynamicZone.querySelectorAll('[data-engine-wrapper]');
              wrappers.forEach(function (w) {
                var id = w.getAttribute('data-engine-wrapper');
                if (!id) return;
                if (!allowed.has(id)) {
                  w.parentNode.removeChild(w);
                }
              });
            }

            // Rend un champ PJM (select ou input) dans la zone dynamique
            // et renvoie le wrapper pour gérer le scroll
            function renderPjmField(f) {
              if (!f || !f.id) return null;

              var existing = dynamicZone.querySelector(
                '[data-engine-wrapper="' + f.id + '"]'
              );

              var valueToApply = f.selectedValue || f.defaultValue || '';

              // Si le wrapper existe déjà, on met juste à jour la valeur
              if (existing) {
                var existingInput = existing.querySelector('[data-engine-id="' + f.id + '"]');
                if (existingInput && valueToApply !== '' && existingInput.value !== valueToApply) {
                  existingInput.value = valueToApply;
                }
                return existing;
              }

              // Sinon on crée le wrapper + label + input
              var wrapper = document.createElement('div');
              wrapper.setAttribute('data-engine-wrapper', f.id);
              wrapper.className = 'option-wrapper';

              var label = document.createElement('div');
              label.className = 'field-label';
              label.textContent = f.label || 'Option';
              wrapper.appendChild(label);

              var input;
              var fieldName = 'engine_' + f.id;

              // Champs libres
              if (
                f.type === 'number' ||
                (f.type === 'text' && (!f.options || f.options.length === 0))
              ) {
                input = document.createElement('input');
                input.type = f.type === 'number' ? 'number' : 'text';
                if (valueToApply) input.value = valueToApply;
              } else if (f.type === 'text') {
                input = document.createElement('input');
                input.type = 'text';
                if (valueToApply) input.value = valueToApply;
              } else {
                // Select avec liste d'options
                input = document.createElement('select');

                var placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = 'Please select...';
                input.appendChild(placeholder);

                (f.options || []).forEach(function (o) {
                  var opt = document.createElement('option');
                  opt.value = o.value;
                  opt.textContent = o.key;
                  input.appendChild(opt);
                });

                if (valueToApply) {
                  input.value = valueToApply;
                }
              }

              input.name = fieldName;
              input.setAttribute('data-engine-id', f.id);

              // À chaque changement → nouvel aller-retour PJM
              input.addEventListener('change', function () {
                fetchNextOption(true);
              });

              wrapper.appendChild(input);
              dynamicZone.appendChild(wrapper);
              return wrapper;
            }

            // Enchaîne les étapes déjà pré-remplies (IA ou valeur par défaut PJM)
            async function fetchNextOption(autoChain) {
              // récupère les valeurs actuelles dans le DOM
              collectSelections();

              var res = await fetch('/pjm/next-option/' + token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ engineSelections: engineSelections })
              });

              var data;
              try {
                data = await res.json();
              } catch (e) {
                console.error('Error parsing /pjm/next-option response', e);
                return;
              }

              // Nettoyage d’éventuels champs devenus invalides côté PJM
              if (Array.isArray(data.allowedIds)) {
                removeFieldsNotAllowed(data.allowedIds);
              }

              // Afficher toutes les options déjà “répondues” (IA + utilisateur)
              if (Array.isArray(data.doneOptions)) {
                data.doneOptions.forEach(function (f) {
                  renderPjmField(f);
                });
              }

              // 👉 Calcul du total et du nombre d’options confirmées
              var totalOptions = data.totalOptions;
              if (!totalOptions) {
                if (Array.isArray(data.allowedIds) && data.allowedIds.length) {
                  totalOptions = data.allowedIds.length;
                } else if (Array.isArray(data.doneOptions)) {
                  totalOptions = data.doneOptions.length + (data.nextField ? 1 : 0);
                } else {
                  totalOptions = data.nextField ? 1 : 0;
                }
              }

              var doneCount = Array.isArray(data.doneOptions)
                ? data.doneOptions.length
                : 0;
              if (data.done && totalOptions && doneCount < totalOptions) {
                doneCount = totalOptions;
              }

              updateProgress(doneCount, totalOptions);

              // Si tout est rempli, on active le bouton et on s’arrête
              if (data.done || !data.nextField) {
                submitBtn.disabled = !data.done;
                return;
              }

              // Afficher la première option encore à compléter
              var f = data.nextField;
              var wrapper = renderPjmField(f);

              var hasPreselectedValue = !!(f.selectedValue || f.defaultValue);

              // Bouton désactivé tant qu’il reste au moins une option sans valeur
              submitBtn.disabled = true;

              // ✅ Scroll fin : offset différent mobile / desktop
              if (wrapper) {
                var rect = wrapper.getBoundingClientRect();
                var viewportHeight =
                  window.innerHeight || document.documentElement.clientHeight;
                var isMobile = window.innerWidth <= 768;
                var factor = isMobile ? 0.22 : 0.30; // ≈ 22% mobile, 30% desktop

                var targetY = window.scrollY + rect.top - viewportHeight * factor;
                if (targetY < 0) targetY = 0;

                window.scrollTo({
                  top: targetY,
                  behavior: 'smooth'
                });
              }

              // Si on est en mode autoChain ET que la question a déjà une valeur,
              // on enchaîne automatiquement pour aller chercher la suivante.
              if (autoChain && hasPreselectedValue) {
                setTimeout(function () {
                  fetchNextOption(true);
                }, 0);
              }
            }

            // Premier appel : on veut enchaîner automatiquement
            fetchNextOption(true);
          })();
        </script>
            <footer class="page-footer">
      <div class="page-footer-inner">
        <span>
          Quote assistant connected to PrintJobManager.
        </span>
        <span>
          Need help? You can reply to the original email and our team will assist you.
        </span>
      </div>
    </footer>


      </body>
    </html>
  `);

});


app.post(
  '/form/:token',
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const token = req.params.token;
    const session = sessions[token];

    if (!session) {
      return res.status(404).send('<p>Invalid or expired link.</p>');
    }

    const { productTypeId, aiResult } = session;

    // 1) Récupérer les choix PJM envoyés par le formulaire (les <select>)
    const engineSelections = {};

    Object.entries(req.body).forEach(([key, value]) => {
          // Sauvegarder aussi le destinataire du devis dans la session
    session.recipientFirstName = req.body.recipient_first_name || null;
    session.recipientLastName = req.body.recipient_last_name || null;

      if (!value) return;
      if (key.startsWith('engine_')) {
        const id = key.slice('engine_'.length); // on enlève "engine_"
        engineSelections[id] = value;
      }
    });

    session.engineSelections = engineSelections;

    console.log('✅ Engine selections from form:');
    console.dir(engineSelections, { depth: null });

    // 2) Fusionner IA + formulaire texte dans "completedRequest"
    const mergedFields = { ...(aiResult.fields || {}) };

    for (const [fieldId, formValue] of Object.entries(req.body)) {
      // on ignore les champs engine_* qui servent juste à PJM
      if (fieldId.startsWith('engine_')) continue;

      mergedFields[fieldId] = {
        value: formValue,
        confidence: 1.0,
        source: 'form'
      };
    }

    session.completedRequest = {
      product_type_id: productTypeId,
      fields: mergedFields
    };

    // 3) Construire une version normalisée (prête pour PJM)
    const normalized = buildNormalizedRequest(session.completedRequest);
    session.normalizedRequest = normalized;

    let quote;
    let usedPjm = false;
    let pjmOptions = session.pjmOptions || null;
    let productRow = null;

    try {
      productRow = products.find(
        (p) => p.product_type_id === productTypeId
      );
      if (!productRow) {
        throw new Error(
          `Unknown product_type_id in products.json: ${productTypeId}`
        );
      }

      // 1) Récupérer les options du moteur si on ne les a pas déjà
      if (!pjmOptions) {
        pjmOptions = await getPjmEngineOptionsForProduct(productRow);
        session.pjmOptions = pjmOptions;
      }

      // 2) Appeler optionsandprice avec ces options + les données normalisées
      quote = await callPjmPrice(normalized, productRow, pjmOptions);
      usedPjm = true;
    } catch (err) {
      console.error(
        '❌ PJM quote failed, falling back to mock quote:',
        err.message
      );
      quote = mockPjmQuote(normalized);
    }

    session.quote = quote;

    // 4) Créer le job "Estimate" dans PJM (si possible)
    let pjmJobResult = null;
    try {
      if (productRow && quote) {
        pjmJobResult = await createPjmJob(normalized, quote, productRow, session);
        session.pjmJob = pjmJobResult;
      }
    } catch (err) {
      console.error(
        '❌ Failed to create PJM job from session:',
        err.message
      );
    }

        console.log('✅ Completed request for token', token);
    console.log('Normalized request:');
    console.dir(normalized, { depth: null });
    console.log('Quote returned (PJM or mock):');
    console.dir(quote, { depth: null });

        const requesterEmail = session.requesterEmail || '';

    // --- Build a readable summary of PJM print options ---
    let optionsSummaryHtml = '<p>No print options were selected.</p>';
    const engineSelectionsReadable = [];

    if (pjmOptions && Array.isArray(pjmOptions.Options)) {
      const selections = session.engineSelections || {};
      for (const [optId, val] of Object.entries(selections)) {
        const optDef = pjmOptions.Options.find((o) => o.Id === optId);
        if (!optDef) continue;

        let niceValue = String(val);
        const choices = optDef.Options || [];
        if (choices.length) {
          const foundChoice = choices.find(
            (c) => String(c.Value) === String(val)
          );
          if (foundChoice) {
            niceValue = foundChoice.Key;
          }
        }

        engineSelectionsReadable.push({
          label: optDef.Label || optId,
          value: niceValue
        });
      }
    }

    if (engineSelectionsReadable.length) {
      optionsSummaryHtml =
        '<ul class="summary-list">' +
        engineSelectionsReadable
          .map(
            (o) =>
              `<li><span class="label">${escapeHtml(
                o.label
              )}</span><span class="value">${escapeHtml(o.value)}</span></li>`
          )
          .join('') +
        '</ul>';
    }

    // --- Try to grab a quote / job reference from PJM ---
    let quoteRef = null;
    const job = session.pjmJob || null;
    if (job) {
      quoteRef =
        job.orderNumber ??
        job.OrderNumber ??
        job.orderId ??
        job.OrderId ??
        (job.Jobs &&
          job.Jobs[0] &&
          (job.Jobs[0].JobNumber || job.Jobs[0].JobId));
    }

    const quoteRefHtml = quoteRef
      ? `<p class="quote-ref">PJM quote reference: <strong>${escapeHtml(
          String(quoteRef)
        )}</strong></p>`
      : '';

    // --- Thank-you page + summary ---
    res.send(`
      <html>
        <head>
          <meta charset="utf-8">
          <title>Thank you for your quote request</title>
          <style>
            :root {
              color-scheme: light dark;
            }
            body {
              margin: 0;
              padding: 40px 16px;
              font-family: system-ui, -apple-system, BlinkMacSystemFont,
                "Segoe UI", Arial, sans-serif;
              background: radial-gradient(circle at top, #1d4ed8 0, #020617 55%);
              color: #0f172a;
            }
            .page {
              max-width: 820px;
              margin: 0 auto;
            }
            /* Carte principale + colonne de droite plus modernes */
.card {
  border-radius: 20px;
  padding: 22px 20px 24px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  box-shadow: 0 20px 45px rgba(15, 23, 42, 0.45);
  background: radial-gradient(circle at top left, #ffffff 0, #f8fafc 55%);
}
            .check {
              width: 40px;
              height: 40px;
              border-radius: 999px;
              display: flex;
              align-items: center;
              justify-content: center;
              background: linear-gradient(135deg, #22c55e, #16a34a);
              color: #ffffff;
              font-weight: 700;
              font-size: 20px;
              box-shadow: 0 10px 25px rgba(22, 163, 74, 0.5);
              flex-shrink: 0;
            }
            .badge {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 3px 9px;
              border-radius: 999px;
              background: rgba(59, 130, 246, 0.08);
              color: #1d4ed8;
              font-size: 11px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.06em;
            }
            h1 {
              font-size: 22px;
              margin: 6px 0 4px;
            }
            h2 {
              font-size: 17px;
              margin: 20px 0 8px;
            }
            p {
              margin: 6px 0;
              font-size: 14px;
            }
            .summary-grid {
              display: grid;
              grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
              gap: 10px 24px;
              margin-top: 10px;
              font-size: 14px;
            }
            .summary-grid-item dt {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: #94a3b8;
              margin-bottom: 2px;
            }
            .summary-grid-item dd {
              margin: 0;
              font-weight: 600;
              color: #0f172a;
            }
            .summary-list {
              list-style: none;
              margin: 6px 0 0;
              padding: 0;
              border-radius: 10px;
              border: 1px solid #e2e8f0;
              background: #f8fafc;
            }
            .summary-list li {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              gap: 12px;
              padding: 8px 10px;
              border-bottom: 1px solid #e2e8f0;
              font-size: 14px;
            }
            .summary-list li:last-child {
              border-bottom: none;
            }
            .summary-list .label {
              color: #64748b;
            }
            .summary-list .value {
              font-weight: 600;
              color: #0f172a;
              text-align: right;
            }
            .quote-ref {
              margin-top: 8px;
              font-size: 14px;
              color: #0f172a;
            }
            .footer-note {
              margin-top: 20px;
              font-size: 12px;
              color: #64748b;
            }
            @media (max-width: 640px) {
              .card {
                padding: 20px 16px 18px;
              }
              .summary-grid {
                grid-template-columns: minmax(0, 1fr);
              }
            }
              /* === Barre de progression du wizard === */
/* === Barre de progression du wizard === */
.wizard-progress {
  margin: 6px 0 8px;
}

.wizard-progress-header {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.wizard-progress-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
}

.wizard-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2563eb, #22c55e);
  transition: width 0.2s ease-out;
}

/* Variante compacte quand la barre est à côté du bouton */
.wizard-progress--inline {
  flex: 1 1 auto;
  min-width: 0;
}

/* Footer du wizard + bouton sticky sur mobile */
.wizard-footer {
  margin-top: 10px;
}

.sticky-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Desktop : progress à gauche, bouton à droite */
@media (min-width: 769px) {
  .sticky-actions {
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  #btnSubmit {
    width: auto;
    min-width: 220px;
  }
}

/* Mobile : progress au-dessus, bouton plein largeur sticky */
@media (max-width: 768px) {
  .sticky-actions {
    position: sticky;
    bottom: 0;
    padding-top: 8px;
    margin-left: -4px;
    margin-right: -4px;
    background: linear-gradient(
      to top,
      rgba(248, 250, 252, 0.95),
      rgba(248, 250, 252, 0)
    );
  }

  #btnSubmit {
    width: 100%;
  }
}


          </style>
        </head>
        <body>
          <div class="page">
            <div class="card">
              <div class="card-header">
                <div class="check">✓</div>
                <div>
                  <div class="badge">Quote request sent</div>
                  <h1>Thank you, your quote request has been submitted.</h1>
                  <p>
                    You will receive your quote shortly at
                    <strong>${escapeHtml(requesterEmail || 'your email')}</strong>.
                  </p>
                  ${quoteRefHtml}
                </div>
              </div>

              <section>
                <h2>Summary of your request</h2>
                <dl class="summary-grid">
                  <div class="summary-grid-item">
                    <dt>Product type</dt>
                    <dd>${escapeHtml(productTypeId || '')}</dd>
                  </div>
                  <div class="summary-grid-item">
                    <dt>Job title</dt>
                    <dd>${escapeHtml(normalized.jobTitle || '—')}</dd>
                  </div>
                  <div class="summary-grid-item">
                    <dt>Quantity</dt>
                    <dd>${normalized.quantity ?? '—'}</dd>
                  </div>
                  <div class="summary-grid-item">
                    <dt>Size</dt>
                    <dd>${escapeHtml(normalized.sizeGroup || '—')}</dd>
                  </div>
                  <div class="summary-grid-item">
                    <dt>Colour mode</dt>
                    <dd>${escapeHtml(normalized.colourMode || '—')}</dd>
                  </div>
                  <div class="summary-grid-item">
                    <dt>Requested date</dt>
                    <dd>${escapeHtml(normalized.deadlineDate || '—')}</dd>
                  </div>
                </dl>
              </section>

              <section style="margin-top:18px;">
                <h2>Print options</h2>
                ${optionsSummaryHtml}
              </section>

              <p class="footer-note">
                You can keep this page as an acknowledgement of receipt.
                If you need any changes, simply reply to the quote email.
              </p>
            </div>
          </div>
        </body>
      </html>
    `);

  }
);





function buildNormalizedRequest(completedRequest) {
  const fields = completedRequest.fields || {};

  const get = (id) =>
    fields[id] && fields[id].value != null
      ? String(fields[id].value).trim()
      : null;

  // Quantity → entier
  const quantityStr = get('quantity');
  const quantity = quantityStr ? parseInt(quantityStr, 10) : null;

  // Size group → normaliser sur nos codes internes (BC, A4, etc.)
  const rawSize = get('size_group');
  const knownSizes = ['BC', 'DL', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0'];
  let sizeGroup = rawSize ? rawSize.toUpperCase() : null;

  if (sizeGroup && !knownSizes.includes(sizeGroup)) {
    const lower = rawSize.toLowerCase();
    if (lower.includes('business card')) {
      sizeGroup = 'BC';
    } else {
      sizeGroup = null; // on ne sait pas, à traiter plus tard si besoin
    }
  }
  // après cette logique :
if (!sizeGroup && completedRequest.product_type_id === 'BUSINESS_CARD_STD') {
  sizeGroup = 'BC';
}


  // Colour mode → COLOUR / B&W / EITHER
  let colourMode = get('colour_mode');
  if (colourMode) {
    const lower = colourMode.toLowerCase();
    if (lower.includes('colour') || lower.includes('color')) {
      colourMode = 'COLOUR';
    } else if (
      lower.includes('black and white') ||
      lower.includes('black & white') ||
      lower === 'b&w' ||
      lower === 'bw'
    ) {
      colourMode = 'B&W';
    } else {
      colourMode = colourMode.toUpperCase();
    }
  }

  const normalized = {
    productTypeId: completedRequest.product_type_id,
    jobTitle: get('job_title'),
    clientName: get('client_name'),
    deptSection: get('dept_section'),
    departmentCode: get('department_code'),
    quantity,
    sizeGroup,
    colourMode,
    deadlineDate: get('deadline_date'),
    // On garde les champs bruts pour debug / futur mapping PJM
    rawFields: fields
  };

  return normalized;
}
function mockPjmQuote(normalizedRequest) {
  const qty = normalizedRequest.quantity || 0;
  const isColour = normalizedRequest.colourMode === 'COLOUR';

  // Petites règles bidon pour la V1 (juste pour tester le flux)
  const baseUnit = isColour ? 0.12 : 0.06; // prix unitaire approximatif
  const setup = qty > 0 ? 15 : 0; // frais de mise en route

  const unitPrice = baseUnit;
  const totalExGst = qty * unitPrice + setup;
  const gstRate = 0.10;
  const gst = totalExGst * gstRate;
  const totalIncGst = totalExGst + gst;

  return {
    currency: 'AUD',
    quantity: qty,
    unitPrice: Number(unitPrice.toFixed(4)),
    setup,
    totalExGst: Number(totalExGst.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    totalIncGst: Number(totalIncGst.toFixed(2))
  };
}

async function getPjmToken() {
  const now = Date.now();
  if (pjmAuthCache.token && pjmAuthCache.expiresAt && now < pjmAuthCache.expiresAt) {
    return pjmAuthCache.token;
  }

  if (!PJM_BASE_URL || !PJM_USERNAME || !PJM_PASSWORD) {
    throw new Error('PJM env vars missing (PJM_BASE_URL, PJM_USERNAME, PJM_PASSWORD)');
  }

  const url = `${PJM_BASE_URL}/public/Authenticate`;

  console.log('➡️ Calling PJM Authenticate (POST):', url);

  const response = await fetch(url, {
    method: 'POST', // ✅ POST, pour pouvoir envoyer un body
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      UserName: PJM_USERNAME,
      Password: PJM_PASSWORD
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`PJM auth response is not JSON: ${text}`);
  }

  if (!response.ok) {
    console.error('❌ PJM auth error response:', data);
    throw new Error(`PJM authenticate failed: ${response.status} - ${text}`);
  }

  // D’après ton screenshot, le champ s’appelle "Token"
  const token = data.Token || data.token;
  if (!token) {
    console.log('PJM auth response structure:', data);
    throw new Error('No Token field found in PJM authenticate response');
  }

  pjmAuthCache = {
    token,
    // on suppose 50 min de validité
    expiresAt: Date.now() + 50 * 60 * 1000
  };

  console.log('✅ PJM token acquired');
  return token;
}
/**
 * Récupère la liste des organisations PJM via /public/Organizations/list
 * et renvoie un tableau simplifié : [{ name, integrationId, raw }, ...]
 */
async function getPjmOrganizationsList(search = '', take = 200, skip = 0) {
  const authToken = await getPjmToken();
  const url = `${PJM_BASE_URL}/public/Organizations/list`;

  const payload = {
    Take: take,
    Skip: skip,
    Search: search || ''
  };

  console.log('➡️ Fetching PJM organizations list:', url);
  console.dir(payload, { depth: null });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('❌ PJM /public/Organizations/list response is not JSON:', text);
    throw new Error('PJM organizations list: invalid JSON');
  }

  if (!response.ok) {
    console.error('❌ PJM /public/Organizations/list error response:', data);
    throw new Error(`PJM organizations list failed: ${response.status} - ${text}`);
  }

  // On essaye de retrouver le tableau d’items dans la réponse
  const rawItems =
    data.Items ||
    data.items ||
    data.Data ||
    data.organizations ||
    (Array.isArray(data) ? data : []);

  const itemsArray = Array.isArray(rawItems) ? rawItems : [];

  const normalized = itemsArray
    .map((item) => {
      const name =
        item.Name ||
        item.name ||
        item.OrganizationName ||
        item.organizationName ||
        '';
      const integrationId =
        item.IntegrationId || item.integrationId || null;

      return {
        name,
        integrationId,
        raw: item
      };
    })
    .filter((o) => o.name);

  console.log(
    '✅ PJM organizations list fetched, count:',
    normalized.length
  );

  return normalized;
}


async function callPjmEngine(operation, productId, optionsArray = []) {
  const token = await getPjmToken();

  const url = `${PJM_BASE_URL}/public/engine`;

  const payload = {
    Operation: operation,      // "options" ou "optionsandprice"
    Product: productId,        // GUID du moteur PJM
    Options: optionsArray      // tableau d'options PJM
  };

  console.log(`➡️ Calling PJM engine [${operation}] for product ${productId}`);
  console.dir(payload, { depth: null });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`PJM engine response is not JSON: ${text}`);
  }

  if (!response.ok) {
    console.error('❌ PJM engine error response:', data);
    throw new Error(`PJM engine failed: ${response.status} - ${text}`);
  }

  return data;
}
async function getPjmEngineOptionsForProduct(productRow) {
  const engineId = productRow.pjm_engine_integration_id;
  if (!engineId) {
    throw new Error(
      `No pjm_engine_integration_id set for product_type_id ${productRow.product_type_id}`
    );
  }

  const data = await callPjmEngine('options', engineId, []);

  // On log pour que tu puisses voir la structure réelle PJM
  console.log('✅ PJM engine options for', productRow.product_type_id);
  console.dir(data, { depth: null });

  return data;
}
// ⚠️ Nouvelle version : même format que ton test Postman
// On envoie à PJM : Options = [ { Key: "<Id du composant>", Value: "<valeur>" }, ... ]
function buildPjmOptionsFromSelections(engineSelections, storedPjmOptions) {
  const result = [];

  Object.entries(engineSelections || {}).forEach(([optId, value]) => {
    if (value === null || value === undefined || value === '') return;

    result.push({
      Key: optId,           // Id du composant PJM
      Value: String(value)  // Valeur choisie (nombre ou GUID d’option)
    });
  });

  return result;
}


function buildPjmOptionsFromNormalized(normalizedRequest, pjmOptionsData) {
  const result = [];
  const optionsList = (pjmOptionsData && pjmOptionsData.Options) || [];

  // Cherche une option PJM dont le Label contient au moins un des mots-clés
  const findByKeywords = (keywords) =>
    optionsList.find((o) => {
      const label = (o.Label || '').toLowerCase();
      return keywords.some((kw) => label.includes(kw.toLowerCase()));
    });

  const logMatch = (label, reason, detail) => {
    if (!DEBUG_MATCHING) return;
    console.log(
      `🔎 [PJM-MATCH] ${label}: ${reason}${detail ? ' → ' + detail : ''}`
    );
  };

  // 1) Quantité d'exemplaires (ou équivalent)
  // 1) Quantité d'exemplaires / Quantity
const qtyOpt = findByKeywords(['quantité', 'quantity', 'qty']);
if (qtyOpt) {
  const isFreeNumeric = (qtyOpt.Options || []).length === 0;

  let qtyValue =
    normalizedRequest.quantity ||
    (normalizedRequest.rawFields &&
      normalizedRequest.rawFields.quantity &&
      normalizedRequest.rawFields.quantity.value) ||
    null;

  // fallback sur default PJM si rien trouvé
  if (qtyValue == null) {
    const def = (qtyOpt.Settings || []).find(
      (s) => s.Key === 'default'
    );
    if (def && def.Value != null) {
      qtyValue = def.Value;
    }
  }

  if (qtyValue == null) qtyValue = 0;

  if (isFreeNumeric) {
    // 🔢 Cas "booklet" : champ libre numérique, pas de Options[]
    result.push({
      Id: qtyOpt.Id,
      Label: qtyOpt.Label,
      Options: [],
      Settings: [
        {
          Key: qtyOpt.Label,
          Value: String(qtyValue)
        }
      ]
    });
    logMatch(
      qtyOpt.Label,
      'free numeric quantity',
      String(qtyValue)
    );
  } else {
    // 🎯 Cas listes prédéfinies (cartes de visite, etc.)
    const valueStr = String(qtyValue);
    result.push({
      Id: qtyOpt.Id,
      Label: qtyOpt.Label,
      Options: [],
      Settings: [
        {
          Key: qtyOpt.Label,
          Value: valueStr
        }
      ]
    });
    logMatch(
      qtyOpt.Label,
      'list-based quantity',
      valueStr
    );
  }
}


  // 2) Impression / mode couleur
  const impOpt = findByKeywords(['impression', 'print']);
  if (impOpt) {
    const opts = impOpt.Options || [];
    let chosen = null;

    if (normalizedRequest.colourMode === 'COLOUR') {
      chosen =
        opts.find((o) =>
          (o.Key || '').toLowerCase().includes('couleur')
        ) || opts[0];
      logMatch(
        impOpt.Label,
        'from colourMode=COLOUR',
        chosen ? `${chosen.Key} (${chosen.Value})` : 'none'
      );
    } else {
      chosen = opts[0];
      if (chosen) {
        logMatch(
          impOpt.Label,
          'fallback first option (non-COLOUR)',
          `${chosen.Key} (${chosen.Value})`
        );
      }
    }

    if (chosen) {
      result.push({
        Id: impOpt.Id,
        Label: impOpt.Label,
        Options: [chosen],
        Settings: [{ Key: 'type', Value: 'single' }]
      });
    }
  }

  // 3) Papier / stock (on prend le 1er papier réel, pas "--Select--")
  const paperOpt = findByKeywords(['papier', 'paper', 'stock']);
  if (paperOpt) {
    const choices = (paperOpt.Options || []).filter(
      (o) =>
        o.Key !== '--Select--' &&
        o.Value !== '00000000-0000-0000-0000-000000000000'
    );
    const chosen = choices[0];
    if (chosen) {
      logMatch(
        paperOpt.Label,
        'fallback first real paper',
        `${chosen.Key} (${chosen.Value})`
      );
      result.push({
        Id: paperOpt.Id,
        Label: paperOpt.Label,
        Options: [chosen],
        Settings: [{ Key: 'type', Value: 'single' }]
      });
    }
  }

  // 4) Pelliculage (par défaut "Aucun" si dispo, sinon 1er)
  const pellOpt = findByKeywords(['pelliculage', 'lamination', 'coating']);
  if (pellOpt) {
    const choices = pellOpt.Options || [];
    let chosen =
      choices.find((o) =>
        (o.Key || '').toLowerCase().includes('aucun')
      ) || choices[0];
    if (chosen) {
      logMatch(
        pellOpt.Label,
        'prefer "Aucun" else first',
        `${chosen.Key} (${chosen.Value})`
      );
      result.push({
        Id: pellOpt.Id,
        Label: pellOpt.Label,
        Options: [chosen],
        Settings: [{ Key: 'type', Value: 'single' }]
      });
    }
  }

  // 5) Révision des fichiers (par défaut "Standard sans B.A.T", sinon 1er)
  const revOpt = findByKeywords([
    'révision des fichiers',
    'file check',
    'preflight'
  ]);
  if (revOpt) {
    const choices = revOpt.Options || [];
    let chosen =
      choices.find((o) =>
        (o.Key || '').toLowerCase().includes('standard sans b.a.t')
      ) || choices[0];
    if (chosen) {
      logMatch(
        revOpt.Label,
        'prefer "Standard sans B.A.T" else first',
        `${chosen.Key} (${chosen.Value})`
      );
      result.push({
        Id: revOpt.Id,
        Label: revOpt.Label,
        Options: [chosen],
        Settings: [{ Key: 'type', Value: 'single' }]
      });
    }
  }

  return result;
}

async function callPjmPrice(normalizedRequest, productRow, pjmOptionsData) {
  const engineId = productRow.pjm_engine_integration_id;
  if (!engineId) {
    throw new Error(
      `No pjm_engine_integration_id for product_type_id ${productRow.product_type_id}`
    );
  }

  // Construire le tableau Options[] pour "optionsandprice"
  const optionsArray = buildPjmOptionsFromNormalized(normalizedRequest, pjmOptionsData);

  const data = await callPjmEngine('optionsandprice', engineId, optionsArray);

  /**
 * Découpe les options PJM en 2 groupes :
 *  - doneOptions : celles qui ont déjà une valeur dans engineSelections
 *  - pendingOptions : celles qui n'ont pas encore de valeur
 *
 * @param {Object} pjmResponse  Réponse brute du /public/engine (avec .Options)
 * @param {Object} engineSelections  Map { [optionId]: value }
 */
function splitPjmOptionsForWizard(pjmResponse, engineSelections) {
  const selections = engineSelections || {};
  const allOptions = (pjmResponse && pjmResponse.Options) || [];

  const doneOptions = [];
  const pendingOptions = [];

  for (const opt of allOptions) {
    const currentValue = selections[opt.Id] ?? null;

    // On clone légèrement pour ajouter la valeur sélectionnée (si existante)
    const enriched = {
      ...opt,
      selectedValue: currentValue
    };

    if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
      doneOptions.push(enriched);
    } else {
      pendingOptions.push(enriched);
    }
  }

  return { doneOptions, pendingOptions };
}


  // On log la réponse brute pour ajuster si besoin
  console.log('✅ PJM optionsandprice response:');
  console.dir(data, { depth: null });

  // On essaie d'en sortir un format "quote" propre
  const total = data.Price ?? data.Total ?? data.TotalExGst ?? 0;
  const qty = normalizedRequest.quantity || data.Quantity || 0;
  const unitPrice = qty > 0 ? total / qty : null;

  const quote = {
    currency: data.Currency || 'AUD',
    quantity: qty,
    unitPrice: unitPrice != null ? Number(unitPrice.toFixed(4)) : null,
    totalExGst: Number(total.toFixed(2)),
    // Ces champs dépendront de la structure réelle renvoyée par ton PJM
    gst: data.Gst ?? null,
    totalIncGst: data.TotalIncGst ?? null,
    rawPjmResponse: data
  };

  return quote;
}
function splitName(fullName) {
  if (!fullName) return { firstName: 'Unknown', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ---- Mapping interne : code de département -> nom d'organisation PJM ----
// ⚠️ À ADAPTER : mets ici tes vrais codes + noms d'organisation PJM
const DEPT_CODE_TO_ORG_NAME = {
  // exemple :
  // 'administration': 'Blacktown Administration',
  // 'finance': 'Blacktown Finance',
  // 'parks': 'Blacktown Parks'
};

/**
 * Retourne le nom d'organisation PJM à partir des infos normalisées.
 * Pour l'instant on essaye d'abord departmentCode, puis deptSection.
 */
function getOrgNameFromNormalized(normalizedRequest) {
  const deptCodeRaw =
    normalizedRequest.departmentCode || normalizedRequest.deptSection;

  if (!deptCodeRaw) return null;

  const deptCode = String(deptCodeRaw).trim().toLowerCase();

  if (DEPT_CODE_TO_ORG_NAME[deptCode]) {
    return DEPT_CODE_TO_ORG_NAME[deptCode];
  }

  // Si on n'a rien dans le mapping, on peut tenter d'utiliser la valeur brute
  // comme nom d'organisation (à ajuster selon la réalité PJM).
  return deptCodeRaw;
}

/**
 * Appelle PJM pour récupérer une organisation par son nom
 * GET /api/public/organizations/{name}
 * et renvoie son IntegrationId (ou null en cas d'erreur).
 */
async function getPjmOrganizationIntegrationIdByName(orgName) {
  if (!orgName) return null;

  const authToken = await getPjmToken();
  const url = `${PJM_BASE_URL}/public/organizations/${encodeURIComponent(orgName)}`;

  console.log('➡️ Fetching PJM organization by name:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('❌ PJM /public/organizations response is not JSON:', text);
    return null;
  }

  if (!response.ok) {
    console.error('❌ PJM /public/organizations error response:', data);
    return null;
  }

  // ✅ Dans ta réponse, les infos sont dans data.Data
  // et le champ est "IntegrationID"
  const orgData = data.Data || data.data || data;

  if (!orgData) {
    console.warn('⚠️ No Data field in organization response:', data);
    return null;
  }

  const integrationId =
    orgData.IntegrationID || // champ réel vu dans ton JSON
    orgData.integrationId ||
    orgData.IntegrationId ||
    null;

  if (!integrationId) {
    console.warn(
      '⚠️ No IntegrationID field found in organization data:',
      orgData
    );
  } else {
    console.log('✅ Found organization IntegrationID:', integrationId);
  }

  return integrationId;
}


/**
 * Helper global : à partir du normalizedRequest,
 * déduire le nom d'organisation puis récupérer son IntegrationId PJM.
 */
async function resolveOrgIntegrationIdFromRequest(normalizedRequest) {
  const orgName = getOrgNameFromNormalized(normalizedRequest);
  if (!orgName) return null;

  const integrationId = await getPjmOrganizationIntegrationIdByName(orgName);
  return integrationId;
}
function truncate(str, maxLen) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}
function logStringFieldsLengths(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return;

  Object.entries(obj).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      console.log(`len(${path}) = ${value.length}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (typeof item === 'string') {
          console.log(`len(${path}[${idx}]) = ${item.length}`);
        } else if (item && typeof item === 'object') {
          logStringFieldsLengths(item, `${path}[${idx}]`);
        }
      });
    } else if (value && typeof value === 'object') {
      logStringFieldsLengths(value, path);
    }
  });
}


/**
 * Crée un job dans PJM via /public/jobs avec statusName = "Estimate"
 * en utilisant :
 *  - normalizedRequest (infos client, qty…)
 *  - quote (prix)
 *  - productRow (engineIntegrationId)
 *  - session.engineSelections (pour engineValues)
 */
async function createPjmJob(normalizedRequest, quote, productRow, session) {
  const authToken = await getPjmToken();
  const url = `${PJM_BASE_URL}/public/jobs`;

  // Email du demandeur (celui qui a envoyé l'email original)
  const requesterEmail =
    session.requesterEmail || 'test@example.com';

  // Nom "client" issu de l'IA
  const clientNameFromAi = normalizedRequest.clientName || 'Client';

  // Nom du destinataire tel que saisi dans le formulaire
  const recipientFirstName = session.recipientFirstName || null;
  const recipientLastName = session.recipientLastName || null;

  let effectiveFirstName = recipientFirstName;
  let effectiveLastName = recipientLastName;

  if (!effectiveFirstName && !effectiveLastName) {
    const split = splitName(clientNameFromAi);
    effectiveFirstName = split.firstName;
    effectiveLastName = split.lastName;
  }

  const recipientFullName = `${effectiveFirstName || ''} ${
    effectiveLastName || ''
  }`.trim() || clientNameFromAi;

  const orgIntegrationId =
    (await resolveOrgIntegrationIdFromRequest(normalizedRequest)) || null;

  const engineSelections = session.engineSelections || {};
  const engineValues = Object.entries(engineSelections).map(
    ([key, value]) => ({
      Key: key,
      Value: value
    })
  );

  // 🔹 Identifiants & textes, version "riche mais serrée"
  //    → on garde des valeurs utiles, mais on coupe agressivement
  const safeOrderId = truncate(
    `A${Date.now().toString().slice(-6)}`,
    12
  ); // ex: A123456
  const safeJobId = truncate(
    `J${Date.now().toString().slice(-6)}`,
    12
  ); // ex: J123456

  const safeJobName = truncate(
    normalizedRequest.jobTitle || productRow.label || 'Print job',
    50
  );

  const safeRecipientName = truncate(recipientFullName, 50);
  const safeBillToBusiness = truncate(
    'Blacktown City Council',
    50
  );
  const safeAddress1 = truncate('1 Civic Centre', 50);
  const safeCity = truncate('Blacktown', 50);
  const safeState = truncate('NSW', 20);
  const safePostal = truncate('2148', 20);
  const safeCountry = truncate('AU', 2);
  const safePhone = truncate('0000000000', 20);
  const safeEmail = truncate(requesterEmail, 80); // email complet mais limité

  const safeCustomerOrderNotes = truncate(
    `Quote requested via orchestrator for ${recipientFullName}`,
    50
  );
  const safeCustomerJobNotes = truncate(
    `Dept: ${normalizedRequest.deptSection || ''} / Code: ${
      normalizedRequest.departmentCode || ''
    }`,
    50
  );
  const safeProductionNotes = truncate(
    'Created automatically from email orchestrator.',
    50
  );

  const reqShipDate =
    normalizedRequest.deadlineDate ||
    new Date().toISOString().slice(0, 10);

  const payload = {
    orderId: safeOrderId,
    orderNumber: 0,
    organizationIntegrationId: orgIntegrationId,

    CSREmail: 'jose.nieto@aleyant.com',
    SalesRepEmail: 'jose.nieto@aleyant.com',
    customerOrderNotes: safeCustomerOrderNotes,
    poNumber: null,

    billToAddressId: null,
    billToName: safeRecipientName,
    billToBusiness: safeBillToBusiness,
    billToAddress1: safeAddress1,
    billToAddress2: null,
    billToAddress3: null,
    billToCity: safeCity,
    BillToState: safeState,
    BillToPostal: safePostal,
    billToCountryCode: safeCountry,
    BillToPhone: safePhone,
    billToEmail: safeEmail,
    billToTitle: null,

    ReqShipDate: reqShipDate,

    Jobs: [
      {
        JobId: safeJobId,
        JobName: safeJobName,
        Quantity: normalizedRequest.quantity || 0,

        Cost: quote.totalExGst || 0,
        Price: quote.totalExGst || 0,
        discount: 0,
        Shipping: 0,
        CalculateTaxes: false,
        Tax: 0,

        customerJobNotes: safeCustomerJobNotes,
        productionNotes: safeProductionNotes,

        shippingMethod: null,

        shipToName: safeRecipientName,
        shipToBusiness: safeBillToBusiness,
        shipToAddress1: safeAddress1,
        shipToAddress2: null,
        shipToAddress3: null,
        shipToCity: safeCity,
        shipToState: safeState,
        shipToPostal: safePostal,
        shipToCountryCode: safeCountry,
        shipToPhone: safePhone,
        shipToEmail: safeEmail,
        shipToAddressId: null,

        reqShipDate: reqShipDate,
        statusName: 'Estimate',

        productionFiles: [],
        uploadedFiles: [],

        engineIntegrationId: productRow.pjm_engine_integration_id,
        engineValues
      }
    ],

    Customer: {
      firstName: truncate(effectiveFirstName || 'Client', 50),
      lastName: truncate(effectiveLastName || '', 50),
      email: safeEmail,
      phone: null,
      fax: null
    },

    payments: []
  };

  console.log('📏 String lengths in PJM payload (enriched & tight):');
  logStringFieldsLengths(payload);

  console.log('➡️ Creating PJM job (Estimate) via /public/jobs');
  console.dir(payload, { depth: null });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `PJM /public/jobs response is not JSON: ${text}`
    );
  }

  if (!response.ok) {
    console.error('❌ PJM /public/jobs error response:', data);
    throw new Error(
      `PJM /public/jobs failed: ${response.status} - ${text}`
    );
  }

  console.log('✅ PJM job created:', data);
  return data;
}






// === Démarrage du serveur ===
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
