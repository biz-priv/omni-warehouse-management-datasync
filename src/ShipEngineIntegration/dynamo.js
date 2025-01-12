const AWS = require("aws-sdk");
const { unset, get } = require("lodash");
const momentTZ = require("moment-timezone");
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { API_STATUS_TABLE, API_LOG_TABLE, CARRIER_SERVICE_LEVEL_MAPPING_TABLE } = process.env;

const InsertedTimeStamp = momentTZ.tz("America/Chicago").format("YYYY:MM:DD HH:mm:ss").toString();

async function insertApiStatus(apiStatusId, status, externalShipmentId) {
    try {
        const params = {
            TableName: API_STATUS_TABLE,
            Item: {
                ShipmentId: externalShipmentId,
                ApiStatusId: apiStatusId,
                StatusUpdate: status,
                InsertedTimeStamp,
            },
        };
        await dynamoDB.put(params).promise();
        console.info(`Inserted API status ShipEngine ${status}`);
    } catch (error) {
        console.error("Error in insertApiStatus:", error);
        throw error;
    }
}

async function updateApiStatus({ attributeName, attributeValue, externalShipmentId }) {
    try {
        const params = {
            TableName: API_STATUS_TABLE,
            Key: { ShipmentId: externalShipmentId },
            UpdateExpression: `SET ${attributeName} = :value`,
            ExpressionAttributeValues: {
                ":value": attributeValue,
            },
        };
        await dynamoDB.update(params).promise();
        console.info(`ApiStatus updated for ${attributeName}`);
    } catch (error) {
        console.error("Error in updateApiStatus:", error);
        throw error;
    }
}

async function updateDynamo(params) {
    try {
        await dynamoDB.update(params).promise();
        console.info(`ApiStatus updated.`);
    } catch (error) {
        console.error("Error in updateDynamo:", error);
        throw error;
    }
}

async function storeApiLog(externalShipmentId, apiName, requestPayload, responsePayload, apiStatusId) {
    try {
        const newObj = { ...responsePayload }
        if (apiName === "ShipEngine") {
            unset(newObj, "label_download");
            unset(newObj, "packages");
        }
        const params = {
            TableName: API_LOG_TABLE,
            Item: {
                ShipmentId: externalShipmentId,
                ApiName: apiName,
                RequestPayload: requestPayload,
                ResponsePayload: apiName === "ShipEngine" ? newObj : responsePayload,
                InsertedTimeStamp,
                ApiStatusId: apiStatusId,
            },
        };
        await dynamoDB.put(params).promise();
        console.info(`ApiLog stored for ${apiName}`);
    } catch (error) {
        console.error("Error in storeApiLog:", error);
        throw error;
    }
}

async function getServiceCode(transportCompany, serviceLevel) {
    const params = {
        TableName: CARRIER_SERVICE_LEVEL_MAPPING_TABLE,
        KeyConditionExpression: 'TransportCompany = :tc and ServiceLevel = :sl',
        ExpressionAttributeValues: {
            ':tc': transportCompany,
            ':sl': serviceLevel === "" ? "DEFAULT" : serviceLevel
        }
    };

    console.info("getServiceCode function params",params);
    try {
        const data = await dynamoDB.query(params).promise();
        console.info("getServiceCodeData",data.Items)
        if (get(data,"Items",[]).length === 0) {
            return false;
        } else {
            return get(data,"Items[0].ServiceCode");
        }
    } catch (error) {
        console.error("Error querying DynamoDB:", error);
        throw error; 
    }
}

module.exports = { updateApiStatus, storeApiLog, insertApiStatus, updateDynamo, getServiceCode };
