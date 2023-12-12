const AWS = require('aws-sdk');
const momentTZ = require("moment-timezone");
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { API_STATUS_TABLE, API_LOG_TABLE } = process.env;
const { get } = require('lodash');

const InsertedTimeStamp = momentTZ.tz("America/Chicago").format("YYYY:MM:DD HH:mm:ss").toString();

async function insertApiStatus(apiStatusId, status, externalShipmentId) {
    try {
        const params = {
            TableName: API_STATUS_TABLE,
            Item: {
                ShipmentId: externalShipmentId,
                ApiStatusId: apiStatusId,
                StatusUpdate: status,
                InsertedTimeStamp
            },
        };
        await dynamoDB.put(params).promise();
        console.info(`Inserted API status ShipEngine ${status}`);
    } catch (error) {
        console.error('Error in insertApiStatus:', error);
        throw error;
    }
}

async function updateApiStatus(apiStatusId, attributeName, attributeValue, externalShipmentId) {
    try {
        const params = {
            TableName: API_STATUS_TABLE,
            Key: { ShipmentId: externalShipmentId },
            UpdateExpression: `SET ${attributeName} = :value`,
            ExpressionAttributeValues: {
                ':value': attributeValue,
            },
        };
        await dynamoDB.update(params).promise();
        console.info(`ApiStatus stored for ${attributeName}`);
    } catch (error) {
        console.error('Error in updateApiStatus:', error);
        throw error;
    }
}

async function storeApiLog(externalShipmentId, apiName, requestPayload, responsePayload, apiStatusId) {
    try {
        const params = {
            TableName: API_LOG_TABLE,
            Item: {
                ShipmentId: externalShipmentId,
                ApiName: apiName,
                RequestPayload: requestPayload,
                ResponsePayload: responsePayload,
                InsertedTimeStamp,
                ApiStatusId: apiStatusId,
            },
        };
        await dynamoDB.put(params).promise();
        console.info(`ApiLog stored for ${apiName}`);
    } catch (error) {
        console.error('Error in storeApiLog:', error);
        throw error;
    }
}

module.exports = { updateApiStatus, storeApiLog, insertApiStatus };
