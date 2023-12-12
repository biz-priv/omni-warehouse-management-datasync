const AWS = require('aws-sdk');
const { get } = require('lodash');
const uuid = require('uuid');
const { ShipEnginePayload, labelEventPayload, trackingShipmentPayload, sendSNSNotification } = require("../shared/datahelper")
const { updateApiStatus, insertApiStatus } = require("../shared/dynamo")
const { getS3Object, makeAndStoreApiCall } = require("../shared/requestor")

module.exports.handler = async (event, context) => {
  let apiStatusId;
  let externalShipmentId;
  let shipmentNumber
  try {
    // Extract XML file from S3 event
    const s3Bucket = event.Records[0].s3.bucket.name;
    const s3Key = event.Records[0].s3.object.key;
    apiStatusId = uuid.v4();
    const xmlData = await getS3Object(s3Bucket, s3Key);
    // Parse XML and construct Shipengine API payload
    const shipenginePayload = await ShipEnginePayload(xmlData);
    // Extract externalShipmentId,shipmentNumber from the payload for correlation
    externalShipmentId = get(shipenginePayload, "shipment.external_shipment_id", "");
    shipmentNumber = get(shipenginePayload, "shipment.shipment_number", "");
    // Insert into ApiStatusTable with status "Processing"
    await insertApiStatus(apiStatusId, 'Processing', externalShipmentId);
    // Make a request to Shipengine API
    const shipengineResponse = await makeAndStoreApiCall('ShipEngine', shipenginePayload, apiStatusId, externalShipmentId);

    // Parse Shipengine API response and construct payloads for Eadapter APIs
    const addLabelPayload = labelEventPayload(shipengineResponse, externalShipmentId);
    const trackingPayload = trackingShipmentPayload(shipengineResponse, externalShipmentId, shipmentNumber);

    // Using Promise.all for parallel execution of Cargowise API calls.
    const CargowiseApiCalls = [
      makeAndStoreApiCall('AddDocument', addLabelPayload, apiStatusId, externalShipmentId),
      makeAndStoreApiCall('AddTracking', trackingPayload, apiStatusId, externalShipmentId),
    ];

    try {
      await Promise.all(CargowiseApiCalls);
    } catch (error) {
      console.error('Error in CargowiseApiCalls:', error);
    }
    await updateApiStatus(apiStatusId, 'StatusUpdate', 'Processed', externalShipmentId);
    console.info("All the API calls are successfull");
  } catch (error) {
    console.error('Error:', error);
    await updateApiStatus(apiStatusId, 'StatusUpdate', 'failure', externalShipmentId);
    await updateApiStatus(apiStatusId, 'ErrorMessage', error.message, externalShipmentId);
    // Send SNS notification
    await sendSNSNotification(`Error occurred in Lambda function ${context.functionName}`, error.message);
    throw error;
  }
};