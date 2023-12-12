const AWS = require('aws-sdk');
const axios = require('axios');
const s3 = new AWS.S3();
const { WMS_ADAPTER_ENDPOINT, WMS_ADAPTER_USERNAME, WMS_ADAPTER_PASSWORD, SHIPENGINE_API_KEY, SHIPENGINE_API_ENDPOINT } = process.env;
const { storeApiLog, updateApiStatus } = require("./dynamo")

async function makeAndStoreApiCall(apiName, payload, apiStatusId, externalShipmentId) {
    try {
        const response = await makeApiRequest(apiName, payload);

        await storeApiLog(externalShipmentId, apiName, payload, response, apiStatusId);
        await updateApiStatus(apiStatusId, `${apiName}Status`, 'Success', externalShipmentId);

        // Conditionally return the response for ShipEngine API
        return apiName === 'ShipEngine' ? response : undefined;
    } catch (error) {
        await handleApiError(apiName, error, apiStatusId, externalShipmentId);
    }
}

async function handleApiError(apiName, error, apiStatusId, externalShipmentId) {
    console.error(`Error in ${apiName} API call: ${error.message}`);
    await updateApiStatus(apiStatusId, `${apiName}Status`, 'failure', externalShipmentId);
    await updateApiStatus(apiStatusId, 'ErrorMessage', error.message, externalShipmentId);
    throw new Error(`Error in ${apiName} API call: ${error.message}`);
}

async function getS3Object(bucket, key) {
    try {
        const params = { Bucket: bucket, Key: key };
        const response = await s3.getObject(params).promise();
        return response.Body.toString();
    } catch (error) {
        throw new Error(`S3 error: ${error}`)
    }
}

async function makeApiRequest(apiName, payload) {
    try {
        let ApiEndpoint;
        let ApiHeaders;

        if (apiName === 'ShipEngine') {
            ApiEndpoint = SHIPENGINE_API_ENDPOINT;
            ApiHeaders = {
                'Content-Type': 'application/json',
                'api-key': SHIPENGINE_API_KEY,
            };
        } else {
            const credentials = `${WMS_ADAPTER_USERNAME}:${WMS_ADAPTER_PASSWORD}`;
            const base64Credentials = btoa(credentials);
            const authorizationHeader = `Basic ${base64Credentials}`;
            // WMS_ADAPTER_ENDPOINT env for wms endpoint
            ApiEndpoint = WMS_ADAPTER_ENDPOINT;
            ApiHeaders = {
                'Content-Type': 'application/xml',
                'Authorization': authorizationHeader,
            };
        }
        console.log("ApiEndpoint:", ApiEndpoint, "ApiHeaders:", ApiHeaders);
        const response = await axios.post(ApiEndpoint, payload, { headers: ApiHeaders });

        if (response.data?.Status === 'ERR') {
            console.log(`ShipEngine API error: ${response.data.ProcessingLog}`);
            throw new Error(`ShipEngine API error: ${response.data.ProcessingLog}`);
        }
        return response.data;
    } catch (error) {
        throw new Error(`Failed to make API request to ${apiName}: ${error.response.data}`);
    }
}

module.exports = { getS3Object, makeAndStoreApiCall }