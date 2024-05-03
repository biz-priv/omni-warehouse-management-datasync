const AWS = require("aws-sdk");
const xml2js = require("xml2js");
const { get, map, set } = require("lodash");
const { getServiceCode } = require("./dynamo");
const { getProductValuesApiCall } = require("./requestor");
const sns = new AWS.SNS();

async function createShipEnginePayload(xmlData) {
    try {
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        let xmnlObj = await parser.parseStringPromise(xmlData);
        xmnlObj = get(xmnlObj, "UniversalInterchange.Body");
        console.info(`🙂 -> file: datahelper.js:664 -> xmnlObj:`, JSON.stringify(xmnlObj));

        if (!get(xmnlObj, "UniversalShipment")) {
            throw new Error("Invalid XML format or missing UniversalShipment element.");
        }

        const consigneeAddress = get(xmnlObj, "UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress", []).filter((add) => get(add, "AddressType") === "ConsigneeAddress")[0];
        console.info(`🙂 -> file: datahelper.js:673 -> consigneeAddress:`, consigneeAddress);
        const addressResidentialIndicator = !get(consigneeAddress, "IsResidential", false) || get(consigneeAddress, "IsResidential", "false") === "false" ? "no" : "yes";
        console.info(`🙂 -> file: datahelper.js:675 -> addressResidentialIndicator:`, addressResidentialIndicator);

        const transportCompanyDocumentaryAddress = get(xmnlObj, "UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress", []).filter((add) => get(add, "AddressType") === "TransportCompanyDocumentaryAddress")[0];
        console.info(`🙂 -> file: datahelper.js:23 -> transportCompanyDocumentaryAddress:`, transportCompanyDocumentaryAddress);
        const transportCompany = get(transportCompanyDocumentaryAddress, "OrganizationCode", "");
        console.info(`🙂 -> file: datahelper.js:1017 -> transportCompany:`, transportCompany);
        const serviceLevel = get(xmnlObj, "UniversalShipment.Shipment.CarrierServiceLevel.Code", "");
        console.info(`🙂 -> file: datahelper.js:1019 -> serviceLevel:`, serviceLevel);
        const serviceCode = await getServiceCode(transportCompany, serviceLevel);
        console.info(`🙂 -> file: datahelper.js:1021 -> serviceCode:`, serviceCode);
        const consignorDocumentaryAddress = get(xmnlObj, "UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress", []).filter((add) => get(add, "AddressType") === "ConsignorDocumentaryAddress")[0];
        const consignorDocumentary = get(consignorDocumentaryAddress, "OrganizationCode", "")
        let packingLineData = get(xmnlObj, "UniversalShipment.Shipment.PackingLineCollection.PackingLine", {});
        let packages;
        if (Array.isArray(packingLineData)) {
            packages = map(packingLineData, (packingLine) => ({
                weight: {
                    value: parseFloat(get(packingLine, "Weight", 0)),
                    unit: "pound",
                },
                dimensions: {
                    height: parseFloat(get(packingLine, "Height", 0)),
                    width: parseFloat(get(packingLine, "Width", 0)),
                    length: parseFloat(get(packingLine, "Length", 0)),
                    unit: "inch",
                },
                label_messages: {
                    reference1: `${get(xmnlObj, "UniversalShipment.Shipment.Order.OrderNumber", "")}`,
                    reference2: `${get(xmnlObj, "UniversalShipment.Shipment.Order.ClientReference", "")}`
                },
            }));
        } else if (Object.keys(packingLineData).length > 0) {
            packages = [
                {
                    weight: {
                        value: parseFloat(get(packingLineData, "Weight", 0)),
                        unit: "pound",
                    },
                    dimensions: {
                        height: parseFloat(get(packingLineData, "Height", 0)),
                        width: parseFloat(get(packingLineData, "Width", 0)),
                        length: parseFloat(get(packingLineData, "Length", 0)),
                        unit: "inch",
                    },
                    label_messages: {
                        reference1: `${get(xmnlObj, "UniversalShipment.Shipment.Order.OrderNumber", "")}`,
                        reference2: `${get(xmnlObj, "UniversalShipment.Shipment.Order.ClientReference", "")}`
                    },
                },
            ];
        } else {
            packages = [];
        }

        const orderLine = get(xmnlObj, "UniversalShipment.Shipment.Order.OrderLineCollection.OrderLine", []);
        let items;
        if (Array.isArray(orderLine)) {
            items = map(get(xmnlObj, "UniversalShipment.Shipment.Order.OrderLineCollection.OrderLine", []), (orderLine) => ({
                sku: get(orderLine, "Product.Code", ""),
                name: get(orderLine, "Product.Description", ""),
                quantity: parseFloat(get(orderLine, "QuantityMet", 0)),
            }))
        } else if (Object.keys(orderLine).length > 0) {
            items = [
                {
                    sku: get(orderLine, "Product.Code", ""),
                    name: get(orderLine, "Product.Description", ""),
                    quantity: parseFloat(get(orderLine, "QuantityMet", 0)),
                }
            ]
        } else {
            items = [];
        }

        let products;
        if (Array.isArray(orderLine)) {
            products = await Promise.all(orderLine.map(async (orderLine) => {
                const { Product, QuantityMet, UnitPriceAfterDiscount } = orderLine;
                const getProductValuesPayload = getProductValues(get(Product, "Code", ""), consignorDocumentary);
                const getProductValuesApiCalls = await getProductValuesApiCall({ payload: getProductValuesPayload });
                const countryOfOrigin = get(getProductValuesApiCalls, "GenCustomAddOnValue[1].Data");
                const harmonizedTariffCode = get(getProductValuesApiCalls, "GenCustomAddOnValue[0].Data");
                return {
                    description: get(Product, "Description", ""),
                    quantity: parseFloat(get(QuantityMet, "", 0)),
                    value: {
                        currency: "USD",
                        amount: parseFloat(get(UnitPriceAfterDiscount, "", 0))
                    },
                    country_of_origin: countryOfOrigin,
                    harmonized_tariff_code: harmonizedTariffCode
                };
            }));
        } else if (Object.keys(orderLine).length > 0) {
            const { Product, QuantityMet, UnitPriceAfterDiscount } = orderLine;
            const getProductValuesPayload = getProductValues(get(Product, "Code", ""), consignorDocumentary);
            const getProductValuesApiCalls = await getProductValuesApiCall({ payload: getProductValuesPayload });
            const countryOfOrigin = get(getProductValuesApiCalls, "GenCustomAddOnValue[1].Data");
            const harmonizedTariffCode = get(getProductValuesApiCalls, "GenCustomAddOnValue[0].Data");
            products = [
                {
                    description: get(Product, "Description", ""),
                    quantity: parseFloat(get(QuantityMet, "", 0)),
                    value: {
                        currency: "USD",
                        amount: parseFloat(get(UnitPriceAfterDiscount, "", 0))
                    },
                    country_of_origin: countryOfOrigin,
                    harmonized_tariff_code: harmonizedTariffCode
                }
            ];
        }
         else {
            products = [];
        }
        const Payload = {
            label_download_type: "inline",
            shipment: {
                ship_from: {
                    name: "Omni Logistics",
                    phone: "856-579-7710",
                    address_line1: "970 Harding Highway, Suite 200",
                    city_locality: "Penns Grove",
                    state_province: "NJ",
                    postal_code: "08069",
                    country_code: "US",
                    address_residential_indicator: "no",
                },
                //external_shipment_id: get(xmnlObj, "UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource.Key", ""),
                confirmation: getIfSignRequired(xmnlObj, "UniversalShipment.Shipment.IsSignatureRequired"),
                shipment_number: get(xmnlObj, "UniversalShipment.Shipment.Order.OrderNumber", ""),
                external_order_id: get(xmnlObj, "UniversalShipment.Shipment.Order.ClientReference", ""),
                items,
                service_code: serviceCode ?? "",
                ship_to: {
                    email: get(consigneeAddress, "Email", ""),
                    address_line3: get(consigneeAddress, "AdditionalAddressInformation", ""),
                    address_line1: get(consigneeAddress, "Address1", ""),
                    address_line2: get(consigneeAddress, "Address2", ""),
                    city_locality: get(consigneeAddress, "City", ""),
                    company_name: get(consigneeAddress, "CompanyName", ""),
                    name: get(consigneeAddress, "Contact", ""),
                    country_code: getCountryCode(transportCompany,get(consigneeAddress, "Country.Code", ""), get(consigneeAddress, "State._", "")),
                    address_residential_indicator: addressResidentialIndicator,
                    phone: get(consigneeAddress, "Phone", ""),
                    postal_code: get(consigneeAddress, "Postcode", ""),
                    state_province: get(consigneeAddress, "State._", ""),
                },
                packages: packages,
            },
        };
        const carrierId = getCarrierId(transportCompany)
        console.info(`🙂 -> file: datahelper.js:985 -> carrierId:`, carrierId);
        if(carrierId){
            set(Payload, "shipment.carrier_id", carrierId)
        }
        if (transportCompany === "DHLWORIAH") {
            Payload.customs = {
                contents: "Merchandise",
                non_delivery: "return_to_sender"
            };
            Payload.products
        }
        if (process.env.ENVIRONMENT === "dev" && transportCompany === "DHLWORIAH") {
            Payload.test_label = true;
        }
        console.log(JSON.stringify(Payload));
        return { shipenginePayload: Payload, skip: !serviceCode , external_shipment_id: get(xmnlObj, "UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource.Key", ""), serviceLevel};
    } catch (error) {
        console.error("Error in createShipEnginePayload:", error.message);
        throw error;
    }
}

const getIfSignRequired = (obj, path) => {
    const isSignatureRequired = get(obj, path);
    return isSignatureRequired === "true" ? "signature" : "delivery";
};

const getCarrierId = (transportCompany) => {
    const carrierIds = {
        UPSAIR: "se-5840017",
        DHLWORIAH: "se-6508487"
    };
    return get(carrierIds, transportCompany, false);
};

function labelEventPayload(data, shipment_id) {
    try {
        const builder = new xml2js.Builder({
            headless: true,
            renderOpts: { pretty: true, indent: "    " },
        });
        const xmlData = {
            UniversalEvent: {
                $: { xmlns: "http://www.cargowise.com/Schemas/Universal/2011/11", version: "1.1" },
                Event: {
                    DataContext: {
                        DataTargetCollection: {
                            DataTarget: {
                                Type: "WarehouseOrder",
                                Key: shipment_id,
                            },
                        },
                    },
                    EventTime: data.created_at,
                    EventType: "DDI",
                    EventReference: "LBL",
                    IsEstimate: false,
                    AttachedDocumentCollection: {
                        AttachedDocument: {
                            FileName: `label ${shipment_id}.pdf`,
                            ImageData: {
                                $: {},
                                _: data.label_download.href.split(",")[1], // extracting base64 data
                            },
                            Type: {
                                Code: "LBL",
                            },
                            IsPublished: true,
                        },
                    },
                },
            },
        };

        return builder.buildObject(xmlData);
    } catch (error) {
        console.error("Error in labelEventPayload:", error);
        throw error;
    }
}

function trackingShipmentPayload(data, shipment_id, OrderNumber) {
    try {
        const builder = new xml2js.Builder({
            headless: true,
            renderOpts: { pretty: true, indent: "    " },
        });

        const xmlData = {
            UniversalShipment: {
                $: { "xmlns:ns0": "http://www.cargowise.com/Schemas/Universal/2011/11" },
                Shipment: {
                    $: { xmlns: "http://www.cargowise.com/Schemas/Universal/2011/11" },
                    DataContext: {
                        DataTargetCollection: {
                            DataTarget: {
                                Type: "WarehouseOrder",
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
    } catch (error) {
        console.error("Error in trackingShipmentPayload:", error);
        throw error;
    }
}

function getProductValues(ProductCode, OrganizationCode) {
    try {
        const builder = new xml2js.Builder({
            headless: true,
            renderOpts: { pretty: true, indent: "    " },
        });

        const xmlData = {
            "Native": {
                "$": {
                    "xmlns": "http://www.cargowise.com/Schemas/Native"
                },
                "Body": {
                    "Product": {
                        "CriteriaGroup": {
                            "$": {
                                "Type": "Partial"
                            },
                            "Criteria": [
                                {
                                    "_": ProductCode,
                                    "$": {
                                        "Entity": "OrgSupplierPart",
                                        "FieldName": "PartNum"
                                    }
                                },
                                {
                                    "_": OrganizationCode,
                                    "$": {
                                        "Entity": "OrgSupplierPart.OrgPartRelation.OrgHeader",
                                        "FieldName": "Code"
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        };
        return builder.buildObject(xmlData);
    } catch (error) {
        console.error("Error in getProductValues:", error);
        throw error;
    }
}

function errorMessagePayload(shipment_id, error) {
    try {
        const builder = new xml2js.Builder({
            headless: true,
            renderOpts: { pretty: true, indent: "    " },
        });

        const xmlData = {
            UniversalShipment: {
                $: { "xmlns:ns0": "http://www.cargowise.com/Schemas/Universal/2011/11" },
                Shipment: {
                    $: { xmlns: "http://www.cargowise.com/Schemas/Universal/2011/11" },
                    DataContext: {
                        DataTargetCollection: {
                            DataTarget: {
                                Type: "WarehouseOrder",
                                Key: shipment_id,
                            },
                        },
                    },
                    NoteCollection: {
                        $: { Content: "Partial" },
                        Note: { Description: "Internal Work Notes", IsCustomDescription: false, NoteText: JSON.stringify(error), NoteContext: { Code: "AAA" }, Visibility: { Code: "INT" } },
                    },
                },
            },
        };
        return builder.buildObject(xmlData);
    } catch (error) {
        console.error("Error in errorMessagePayload:", error);
        throw error;
    }
}

let StateProvinces = ["AS", "GU", "MP", "FM", "PR", "VI"];
function getCountryCode(transportCompany,CountryCode,StateProvince){
    if((transportCompany === "UPSAIR" || transportCompany === "FEDEXMEM") && (StateProvinces.includes(StateProvince))){
        return StateProvince
    }
    if((transportCompany === "USPS") && (StateProvinces.includes(StateProvince))){
        return "US"
    }
        return CountryCode
}

async function sendSNSNotification(subject, message) {
    const params = {
        Subject: subject,
        Message: message,
        TopicArn: process.env.ERROR_SNS_ARN,
    };

    try {
        await sns.publish(params).promise();
        console.log("SNS notification sent successfully.");
    } catch (snsError) {
        console.error("Error sending SNS notification:", snsError);
    }
}

module.exports = { createShipEnginePayload, labelEventPayload, trackingShipmentPayload, sendSNSNotification, errorMessagePayload, getProductValues };
