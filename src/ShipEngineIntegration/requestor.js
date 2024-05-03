const AWS = require("aws-sdk");
const axios = require("axios");
const s3 = new AWS.S3();
const { WMS_ADAPTER_ENDPOINT, WMS_ADAPTER_USERNAME, WMS_ADAPTER_PASSWORD, SHIPENGINE_API_KEY, SHIPENGINE_API_ENDPOINT, API_STATUS_TABLE } = process.env;
const { storeApiLog, updateApiStatus, updateDynamo } = require("./dynamo");
const { get } = require("lodash");
const { errorMessagePayload } = require("./datahelper");

let shipmentId;
async function makeAndStoreApiCall(apiName, payload, apiStatusId, externalShipmentId) {
    shipmentId = externalShipmentId;
    try {
        const response = await makeApiRequest(apiName, payload);

        await storeApiLog(externalShipmentId, apiName, payload, response, apiStatusId);
        await updateApiStatus({ apiStatusId, attributeName: `${apiName}Status`, attributeValue: "Success", externalShipmentId });

        // Conditionally return the response for ShipEngine API
        return apiName === "ShipEngine" ? response : undefined;
    } catch (error) {
        await handleApiError(apiName, error, apiStatusId, externalShipmentId);
    }
}

async function getProductValuesApiCall({payload}) {
    try {
        const response = await makeApiRequest('', payload);
        const parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
        });

        const jsonResponse = await parser.parseStringPromise(response)
        console.log("jsonResponse",jsonResponse)
        const GenCustomAddOnValueCollection = get(UniversalResponse,"Data.Native.Body.Product.GenCustomAddOnValueCollection"," ");
        return GenCustomAddOnValueCollection
    } catch (error) {
        console.error("Error in getProductValuesApiCall:", error);
        throw error;
    }
}

async function handleApiError(apiName, error, apiStatusId, externalShipmentId) {
    console.error(`Error in ${apiName} API call: ${error.message}`);
    const params = {
        TableName: API_STATUS_TABLE,
        Key: { ShipmentId: externalShipmentId },
        UpdateExpression: `SET ${apiName}Status = :StatusUpdate, ErrorMessage = :ErrorMessage`,
        ExpressionAttributeValues: {
            ":StatusUpdate": "FAILED",
            ":ErrorMessage": error.message,
        },
    };
    await updateDynamo(params);
    throw new Error(`Error in ${apiName} API call: ${error.message}`);
}

async function getS3Object(bucket, key) {
    try {
        const params = { Bucket: bucket, Key: key };
        const response = await s3.getObject(params).promise();
        return response.Body.toString();
    } catch (error) {
        throw new Error(`S3 error: ${error}`);
    }
}

async function makeApiRequest(apiName, payload) {
    try {
        let ApiEndpoint;
        let ApiHeaders;

        if (apiName === "ShipEngine") {
            ApiEndpoint = SHIPENGINE_API_ENDPOINT;
            ApiHeaders = {
                "Content-Type": "application/json",
                "api-key": SHIPENGINE_API_KEY,
            };
        } else {
            const credentials = `${WMS_ADAPTER_USERNAME}:${WMS_ADAPTER_PASSWORD}`;
            const base64Credentials = Buffer.from(credentials).toString('base64');
            const authorizationHeader = `Basic ${base64Credentials}`;
            // WMS_ADAPTER_ENDPOINT env for wms endpoint
            ApiEndpoint = WMS_ADAPTER_ENDPOINT;
            ApiHeaders = {
                "Content-Type": "application/xml",
                Authorization: authorizationHeader,
            };
        }
        console.info(`🙂 -> file: requestor.js:56 -> ${apiName} -> ApiEndpoint:`, ApiEndpoint);
        console.info(`🙂 -> file: requestor.js:58 -> ${apiName} -> ApiHeaders:`, ApiHeaders);
        console.info(`🙂 -> file: requestor.js:63 -> ${apiName} -> payload:`, payload);
        const response = await axios.post(ApiEndpoint, payload, { headers: ApiHeaders });
        console.info(`🙂 -> file: requestor.js:65 -> response:`, get(response, "data"));
        if (response.data?.Status === "ERR") {
            console.log(`ShipEngine API error data: ${response.data}`);
            console.log(`ShipEngine API error: ${response.data.ProcessingLog}`);
            throw new Error(`ShipEngine API error: ${response.data.ProcessingLog}`);
        }
        return response.data;
    } catch (error) {
        if (apiName === "ShipEngine") {
            await makeApiRequest("ErrorUpload", errorMessagePayload(shipmentId, get(error, "response.data", "")));
        }
        throw new Error(`Failed to make API request to ${apiName}: ${get(error, "response.data.errors[0].message", "")}`);
    }
}

module.exports = { getS3Object, makeAndStoreApiCall, makeApiRequest, getProductValuesApiCall };
