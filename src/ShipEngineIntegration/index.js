const AWS = require("aws-sdk");
const { get } = require("lodash");
const uuid = require("uuid");
const { createShipEnginePayload, labelEventPayload, trackingShipmentPayload, sendSNSNotification, errorMessagePayload } = require("./datahelper");
const { updateApiStatus, insertApiStatus, updateDynamo } = require("./dynamo");
const { getS3Object, makeAndStoreApiCall, makeApiRequest } = require("./requestor");
const { API_STATUS_TABLE } = process.env;

module.exports.handler = async (event, context) => {
    console.info(`🙂 -> file: index.js:9 -> event:`, JSON.stringify(event));
    let apiStatusId;
    let externalShipmentId;
    let shipmentNumber;
    try {
        // Extract XML file from S3 event
        const s3Bucket = get(event, "Records[0].s3.bucket.name", "");
        const s3Key = get(event, "Records[0].s3.object.key", "");
        const fileName = s3Key.split("/").pop();
        apiStatusId = uuid.v4();
        // Get XML data from S3
        const xmlData = await getS3Object(s3Bucket, s3Key);
        // Parse XML and construct Shipengine API payload
        const { shipenginePayload, skip, external_shipment_id: externalShipmentId , serviceLevel} = await createShipEnginePayload(xmlData);
        // Extract externalShipmentId, shipmentNumber from the payload for correlation
        // externalShipmentId = get(shipenginePayload, "shipment.external_shipment_id", "");
        shipmentNumber = get(shipenginePayload, "shipment.shipment_number", "");
        // Insert into ApiStatusTable with status "Processing"
        await insertApiStatus(apiStatusId, "PROCESSING", externalShipmentId);

        if (skip) {
            const params = {
                TableName: API_STATUS_TABLE,
                Key: { ShipmentId: externalShipmentId },
                UpdateExpression: `SET StatusUpdate = :StatusUpdate, ErrorMessage = :ErrorMessage`,
                ExpressionAttributeValues: {
                    ":StatusUpdate": "SKIPPED",
                    ":ErrorMessage": "Valid service level not present.",
                },
            };
            await updateDynamo(params);
            const skippedSubject = `Skipped processing the file in ${context.functionName}`
            const skippedMessage = `Hello Team, \n The ${fileName} got skipped. \n This is due to an invalid service level received: ${serviceLevel}. \n Note: The same message has already been conveyed to Customers.\n  `
            await sendSNSNotification(skippedSubject,skippedMessage);
            await makeApiRequest("ErrorUpload", errorMessagePayload(shipmentId, `Invalid service level received: ${serviceLevel}`));
            console.info("SKIPPED: Valid service level not present.")
            return "SKIPPED: Valid service level not present.";
        }
        // Make a request to Shipengine API
        const shipengineResponse = await makeAndStoreApiCall("ShipEngine", shipenginePayload, apiStatusId, externalShipmentId);
        // Parse Shipengine API response and construct payloads for Eadapter APIs
        const addLabelPayload = labelEventPayload(shipengineResponse, externalShipmentId);
        const trackingPayload = trackingShipmentPayload(shipengineResponse, externalShipmentId, shipmentNumber);
        // Using Promise.all for parallel execution of Cargowise API calls.
        const CargowiseApiCalls = [makeAndStoreApiCall("AddDocument", addLabelPayload, apiStatusId, externalShipmentId), makeAndStoreApiCall("AddTracking", trackingPayload, apiStatusId, externalShipmentId)];
        try {
            await Promise.all(CargowiseApiCalls);
        } catch (error) {
            console.error("Error in CargowiseApiCalls:", error);
        }
        // Update the status to 'Processed' in ApiStatusTable
        await updateApiStatus({ apiStatusId, attributeName: "StatusUpdate", attributeValue: "PROCESSED", externalShipmentId });
        console.info("All the API calls are successful");
    } catch (error) {
        console.error("Error:", error);
        // Update the status to 'failure' and log error message
        const params = {
            TableName: API_STATUS_TABLE,
            Key: { ShipmentId: externalShipmentId },
            UpdateExpression: `SET StatusUpdate = :StatusUpdate, ErrorMessage = :ErrorMessage`,
            ExpressionAttributeValues: {
                ":StatusUpdate": "FAILED",
                ":ErrorMessage": error.message,
            },
        };
        await updateDynamo(params);
        // Send SNS notification
        await sendSNSNotification(`Error occurred in Lambda function ${context.functionName}`, error.message);
        throw error;
    }
};
