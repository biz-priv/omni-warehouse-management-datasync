const AWS = require('aws-sdk');
const xml2js = require('xml2js');
const { get, map } = require('lodash');


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


function labelEventPayload(data, shipment_id) {
    try {
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
                                _: data.label_download.href.split(',')[1], // extracting base64 data
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
    } catch (error) {
        console.error('Error in labelEventPayload:', error);
        throw error;
    }
}

function trackingShipmentPayload(data, shipment_id, OrderNumber) {
    try {
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
    } catch (error) {
        console.error('Error in trackingShipmentPayload:', error);
        throw error;
    }
}

async function sendSNSNotification(subject, message) {
    const params = {
        Subject: subject,
        Message: message,
        TopicArn: process.env.ERROR_SNS_ARN,
    };

    try {
        await sns.publish(params).promise();
        console.log('SNS notification sent successfully.');
    } catch (snsError) {
        console.error('Error sending SNS notification:', snsError);
    }
}

module.exports = { ShipEnginePayload, labelEventPayload, trackingShipmentPayload, sendSNSNotification }