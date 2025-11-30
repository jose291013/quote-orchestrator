// scripts/csv-to-json.js
const fs = require('fs');
const path = require('path');
const csv = require('csvtojson');

async function convertCsvToJson(inputCsvPath, outputJsonPath) {
  try {
    console.log(`Conversion de ${inputCsvPath} → ${outputJsonPath}`);

    const jsonArray = await csv().fromFile(inputCsvPath);

    // On écrit un joli JSON lisible
    fs.writeFileSync(outputJsonPath, JSON.stringify(jsonArray, null, 2), 'utf8');

    console.log(`✅ OK: ${outputJsonPath}`);
  } catch (err) {
    console.error(`❌ Erreur sur ${inputCsvPath}:`, err);
  }
}

async function run() {
  const baseCsvDir = path.join(__dirname, '..', 'config', 'csv');
  const baseJsonDir = path.join(__dirname, '..', 'config');

  // Assure-toi que ce dossier existe
  if (!fs.existsSync(baseJsonDir)) {
    fs.mkdirSync(baseJsonDir, { recursive: true });
  }

  await convertCsvToJson(
    path.join(baseCsvDir, 'productTypes.csv'),
    path.join(baseJsonDir, 'products.json')
  );

  await convertCsvToJson(
    path.join(baseCsvDir, 'requestFields.csv'),
    path.join(baseJsonDir, 'requestFields.json')
  );

  await convertCsvToJson(
    path.join(baseCsvDir, 'fieldProfiles.csv'),
    path.join(baseJsonDir, 'fieldProfiles.json')
  );

  // Si tu as un 4e onglet utile côté serveur :
  // await convertCsvToJson(
  //   path.join(baseCsvDir, 'productVariants.csv'),
  //   path.join(baseJsonDir, 'productVariants.json')
  // );
}

run();
