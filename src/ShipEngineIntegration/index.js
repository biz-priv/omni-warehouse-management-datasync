const AWS = require('aws-sdk');
const xml2js = require('xml2js');
const { get, map } = require('lodash');
const axios = require('axios');
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const uuid = require('uuid');
const { WMS_ADAPTER_ENDPOINT, WMS_ADAPTER_USERNAME, WMS_ADAPTER_PASSWORD, API_STATUS_TABLE, API_LOG_TABLE } = process.env;

module.exports.handler = async (event) => {
  let apiStatusId;
  let externalShipmentId;
  let shipmentNumber
  try {
    // Extract XML file from S3 event
    const s3Bucket = event.Records[0].s3.bucket.name;
    const s3Key = event.Records[0].s3.object.key;

    // Generate a new apiStatusId and initialize externalShipmentId
    apiStatusId = uuid.v4();
    externalShipmentId = ''; // Set to an empty string initially or use a default value

    // Insert into ApiStatusTable with status "Processing"
    await insertApiStatus(apiStatusId, 'Processing', externalShipmentId);

    const xmlData = await getS3Object(s3Bucket, s3Key);

    // Parse XML and construct Shipengine API payload
    const shipenginePayload = ShipEnginePayload(xmlData);

    // Make a request to Shipengine API
    const shipengineResponse = await makeApiRequest('shipengine', shipenginePayload);

    // Extract external_shipment_id from the payload for correlation
    externalShipmentId = get(shipenginePayload, "external_shipment_id", "");
    shipmentNumber = get(shipenginePayload, "shipment_number", "");

    // Store Shipengine API request and response in DynamoDB
    await storeApiLog(externalShipmentId, 'shipengine', shipenginePayload, shipengineResponse, apiStatusId);

    // Update status in ApiStatusTable for Shipengine API
    await updateApiStatus(apiStatusId, 'shipEngineStatus', 'success', externalShipmentId);

    // Parse Shipengine API response and construct payloads for Eadapter APIs
    const addLabelPayload = labelEventPayload(shipengineResponse, externalShipmentId);
    const trackingPayload = trackingShipmentPayload(shipengineResponse, externalShipmentId, shipmentNumber);

    // Use Promise.all for parallel execution of cargowise API calls.
    await Promise.all([
      makeAndStoreApiCall('addDocument', addLabelPayload, apiStatusId, externalShipmentId),
      makeAndStoreApiCall('addTracking', trackingPayload, apiStatusId, externalShipmentId),
    ]);

  } catch (error) {
    console.error('Error:', error);
    await updateApiStatus(apiStatusId, 'status', 'failure', externalShipmentId);
    await updateApiStatus(apiStatusId, 'errorMessage', error.message, externalShipmentId);
  }
};

async function makeAndStoreApiCall(apiName, payload, apiStatusId, externalShipmentId) {
  try {
    // Make a request to the Eadapter API
    const response = await makeApiRequest(apiName, payload);

    // Store API request and response in DynamoDB
    await storeApiLog(externalShipmentId, apiName, payload, response, apiStatusId);

    // Update status in ApiStatusTable for Eadapter API
    await updateApiStatus(apiStatusId, `${apiName}Status`, 'success', externalShipmentId);
  } catch (error) {
    // Log the error for the specific API call
    console.error(`Error in ${apiName} API call:`, error);

    // Update status in ApiStatusTable for the specific API call
    await updateApiStatus(apiStatusId, `${apiName}Status`, 'failure', externalShipmentId);
    await updateApiStatus(apiStatusId, 'errorMessage', error.message, externalShipmentId);
  }
}


async function getS3Object(bucket, key) {
  const params = { Bucket: bucket, Key: key };
  const response = await s3.getObject(params).promise();
  return response.Body.toString();
}

async function ShipEnginePayload(xmlData) {
  try {
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const xmnlObj = await parser.parseStringPromise(xmlData);

    if (!get(xmnlObj, "UniversalShipment")) {
      throw new Error('Invalid XML format or missing UniversalShipment element.');
    }

    const transportCompany = get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[0].OrganizationCode', '');
    const serviceLevel = get(xmnlObj, 'UniversalShipment.Shipment.CarrierServiceLevel.Code', '');

    const Payload = {
      label_download_type: 'inline',
      shipment: {
        ship_from: {
          name: 'Omni Logistics',
          phone: '650-555-1212',
          address_line1: '970 Harding Highway, Suite 200',
          city_locality: 'Penns Grove',
          state_province: 'NJ',
          postal_code: '08069',
          country_code: 'US',
          address_residential_indicator: 'no',
        },
        external_shipment_id: get(xmnlObj, 'UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource.Key', ''),
        confirmation: getConfirmation(xmnlObj, 'UniversalShipment.Shipment.IsSignatureRequired'),
        shipment_number: get(xmnlObj, 'UniversalShipment.Shipment.Order.OrderNumber', ''),
        external_order_id: get(xmnlObj, 'UniversalShipment.Shipment.Order.ClientReference', ''),
        items: map(get(xmnlObj, 'UniversalShipment.Shipment.Order.OrderLineCollection.OrderLine', []), orderLine => ({
          sku: get(orderLine, 'Product.Code', ''),
          name: get(orderLine, 'Product.Description', ''),
          quantity: parseFloat(get(orderLine, 'QuantityMet', 0)),
        })),
        service_code: getServiceCode(transportCompany, serviceLevel),
        ship_to: {
          email: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Email', ''),
          address_line3: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].AdditionalAddressInformation', ''),
          address_line1: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Address1', ''),
          address_line2: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Address2', ''),
          city_locality: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].City', ''),
          company_name: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].CompanyName', ''),
          name: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Contact', ''),
          country_code: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Country.Code', ''),
          address_residential_indicator: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].IsResidential', 'no'),
          phone: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Phone', ''),
          postal_code: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].Postcode', ''),
          state_province: get(xmnlObj, 'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[1].State._', ''),
        },
        packages: map(get(xmnlObj, 'UniversalShipment.Shipment.PackingLineCollection.PackingLine', []), packingLine => ({
          weight: {
            value: parseFloat(get(packingLine, 'Weight', 0)),
            unit: 'pound',
          },
          dimensions: {
            height: parseFloat(get(packingLine, 'Height', 0)),
            width: parseFloat(get(packingLine, 'Width', 0)),
            length: parseFloat(get(packingLine, 'Length', 0)),
            unit: 'inch',
          },
          label_messages: {
            reference1: `${get(xmnlObj, 'UniversalShipment.Shipment.Order.OrderNumber', '')},${get(xmnlObj, 'UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource.Key', '')},${get(xmnlObj, 'UniversalShipment.Shipment.Order.ClientReference', '')}`,
          },
        })),
      },
    };
    console.log("constructedPayload", JSON.stringify(Payload));
    return Payload;
  } catch (error) {
    console.error('Error in ShipEnginePayload:', error.message);
    throw error;
  }
}

const getConfirmation = (obj, path) => {
  const isSignatureRequired = get(obj, path);
  return isSignatureRequired === 'true' ? 'signature' : 'delivery';
};

const getServiceCode = (transportCompany, serviceLevel) => {
  const serviceCodeMappings = {
    UPSAIR: {
      U1D: 'ups_next_day_air_saver',
      U2D: 'ups_2nd_day_air',
      U3D: 'ups_3_day_select',
      UPS: 'ups_ground',
      GRD: 'ups_ground',
      STD: 'ups_ground',
    },
    DHLWORIAH: {
      STD: 'UNKNOWN',
    },
    FEDEXMEM: {
      STD: 'fedex_ground',
    },
  };

  return serviceCodeMappings?.[transportCompany]?.[serviceLevel] || '';
};
async function makeApiRequest(apiName, payload) {
  try {
    let ApiEndpoint;
    let ApiHeaders;

    if (apiName === 'shipengine') {
      ApiEndpoint = 'https://api.shipengine.com/v1/labels';
      ApiHeaders = {
        'Content-Type': 'application/json',
        'api-key': 'TEST_9Zcka4EvjKLmHf6j9CqJASJJbSLsjvzFhL+m6Tae7Ko',
      };

    } else {
      const credentials = `${WMS_ADAPTER_USERNAME}:${WMS_ADAPTER_PASSWORD}`;
      const base64Credentials = btoa(credentials);
      const authorizationHeader = `Basic ${base64Credentials}`;
      // WMS_ADAPTER_ENDPOINT env for wms endpoint
      ApiEndpoint = WMS_ADAPTER_ENDPOINT;
      ApiHeaders = {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      };
    }
    const response = await axios.post(ApiEndpoint, payload, { headers: ApiHeaders });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to make API request to ${apiName}: ${error.message}`);
  }
}



async function insertApiStatus(apiStatusId, status, externalShipmentId) {
  const params = {
    TableName: API_STATUS_TABLE,
    Item: {
      ApiStatusId: { S: apiStatusId },
      Status: { S: status },
      ShipmentId: { S: '' },
    },
  };
  await dynamoDB.put(params).promise();
}

async function updateApiStatus(apiStatusId, attributeName, attributeValue, externalShipmentId) {
  const params = {
    TableName: API_STATUS_TABLE,
    Key: { ApiStatusId: { S: apiStatusId } },
    UpdateExpression: `SET #${attributeName} = :value, ShipmentId = :externalShipmentId`,
    ExpressionAttributeNames: { '#status': attributeName },
    ExpressionAttributeValues: {
      ':value': { S: attributeValue },
      ':externalShipmentId': { S: externalShipmentId },
    },
  };
  await dynamoDB.update(params).promise();
}

async function storeApiLog(externalShipmentId, apiName, requestPayload, responsePayload, apiStatusId) {
  const params = {
    TableName: API_LOG_TABLE,
    Item: {
      ShipmentId: { S: externalShipmentId },
      ApiName: { S: apiName },
      RequestPayload: { S: requestPayload },
      ResponsePayload: { S: responsePayload },
      Timestamp: { N: Date.now().toString() },
      ApiStatusId: { S: apiStatusId },
    },
  };
  await dynamoDB.put(params).promise();
}

function labelEventPayload(data, shipment_id) {
  const builder = new xml2js.Builder({
    headless: true,
    renderOpts: { pretty: true, indent: '    ' },
  });
  const xmlData = {
    UniversalEvent: {
      $: { xmlns: 'http://www.cargowise.com/Schemas/Universal/2011/11', version: '1.1' },
      Event: {
        DataContext: {
          DataTargetCollection: {
            DataTarget: {
              Type: 'WarehouseOrder',
              Key: shipment_id,
            },
          },
        },
        EventTime: data.created_at,
        EventType: 'DDI',
        EventReference: 'LBL',
        IsEstimate: false,
        AttachedDocumentCollection: {
          AttachedDocument: {
            FileName: `label ${shipment_id}.pdf`,
            ImageData: {
              $: {},
              _: data.label_download.href.split(',')[1], // extract base64 data
            },
            Type: {
              Code: 'LBL',
            },
            IsPublished: true,
          },
        },
      },
    },
  };

  return builder.buildObject(xmlData);
}
function trackingShipmentPayload(data, shipment_id, OrderNumber) {
  const builder = new xml2js.Builder({
    headless: true,
    renderOpts: { pretty: true, indent: '    ' },
  });

  const xmlData = {
    UniversalShipment: {
      $: { 'xmlns:ns0': 'http://www.cargowise.com/Schemas/Universal/2011/11' },
      Shipment: {
        $: { xmlns: 'http://www.cargowise.com/Schemas/Universal/2011/11' },
        DataContext: {
          DataTargetCollection: {
            DataTarget: {
              Type: 'WarehouseOrder',
              Key: shipment_id,
            },
          },
        },
        Order: {
          OrderNumber: OrderNumber,
          TransportReference: data.tracking_number,
        },
      },
    },
  };

  return builder.buildObject(xmlData);
}