/*jshint esversion: 6 */

class TensorFlowLiteModel {
    
    static open(buffer, identifier, host, callback) { 
        try {
            var byteBuffer = new flatbuffers.ByteBuffer(buffer);
            if (!tflite.Model.bufferHasIdentifier(byteBuffer))
            {
                throw new Error('Invalid FlatBuffers identifier.');
            }
            var model = tflite.Model.getRootAsModel(byteBuffer);
            model = new TensorFlowLiteModel(model);
            TensorFlowLiteOperatorMetadata.open(host, (err, metadata) => {
                callback(null, model);
            });
        }
        catch (err) {
            callback(err, null);
        }
    }

    constructor(model) {
        this._model = model;
        this._graphs = [];
        for (var subgraph = 0; subgraph < this._model.subgraphsLength(); subgraph++) {
            this._graphs.push(new TensorFlowLiteGraph(this, this._model.subgraphs(subgraph), subgraph));
        }
        this._activeGraph = this._graphs.length > 0 ? this._graphs[0] : null;
        this._operatorCodeList = [];
        var builtinOperatorMap = {};
        Object.keys(tflite.BuiltinOperator).forEach(function (key) {
            var upperCase = { '2D': true, 'LSH': true, 'SVDF': true, 'RNN': true, 'L2': true, 'LSTM': true };
            var builtinOperatorIndex = tflite.BuiltinOperator[key]; 
            builtinOperatorMap[builtinOperatorIndex] = key.split('_').map((s) => {
                return (s.length < 1 || upperCase[s]) ? s : s.substring(0, 1) + s.substring(1).toLowerCase();
            }).join('');
        });
        for (var operatorIndex = 0; operatorIndex < this._model.operatorCodesLength(); operatorIndex++) {
            var operatorCode = this._model.operatorCodes(operatorIndex);
            var builtinCode = operatorCode.builtinCode();
            this._operatorCodeList.push((builtinCode == tflite.BuiltinOperator.CUSTOM) ? operatorCode.customCode() : builtinOperatorMap[builtinCode]);
        }
    }

    format() {
        var summary = { properties: [], graphs: [] };

        this.graphs.forEach((graph) => {
            summary.graphs.push({
                name: graph.name,
                inputs: graph.inputs,
                outputs: graph.outputs
            });
        });

        var format = 'TensorFlow Lite v' + this._model.version().toString();
        summary.properties.push({ name: 'Format', value: format });

        var description = this._model.description();
        if (description && description.length > 0) {
            summary.properties.push({ name: 'Description', value: description });
        }

        return summary;
    }

    get graphs() {
        return this._graphs;
    }

    get activeGraph() {
        return this._activeGraph;
    }

    updateActiveGraph(name) {
        this.graphs.forEach((graph) => {
            if (name == graph.name) {
                this._activeGraph = graph;
                return;
            }            
        });
    }
} 

class TensorFlowLiteGraph {

    constructor(model, graph, index) {
        this._model = model;
        this._graph = graph;
        this._name = this._graph.name() ? this._graph.name() : ('(' + index.toString() + ')'); 
        
        this._initializerMap = {};
        for (var i = 0; i < graph.tensorsLength(); i++) {
            var tensor = graph.tensors(i);
            var buffer = model._model.buffers(tensor.buffer());
            if (buffer.dataLength() > 0) {
                this._initializerMap[i] = new TensorFlowLiteTensor(tensor, buffer, i);
            }
        }
    }

    get model() {
        return this._model;
    }

    get name() {
        return this._name;
    }

    get inputs() {
        var results = [];
        var graph = this._graph;
        for (var i = 0; i < graph.inputsLength(); i++) {
            var tensorIndex = graph.inputs(i);
            var tensor = graph.tensors(tensorIndex);
            results.push({ 
                id: tensorIndex.toString(),
                name: tensor.name(),
                type: TensorFlowLiteTensor.formatTensorType(tensor) 
            });
        }
        return results;
    }

    get outputs() {
        var results = [];
        var graph = this._graph;
        for (var i = 0; i < graph.outputsLength(); i++) {
            var tensorIndex = graph.outputs(i);
            var tensor = graph.tensors(tensorIndex);
            results.push({ 
                id: tensorIndex.toString(),
                name: tensor.name(),
                type: TensorFlowLiteTensor.formatTensorType(tensor) 
            });
        }
        return results;
    }

    get nodes() {
        /* for (var i = 0; i < graph.operatorsLength(); i++) {
            var node = graph.operators(i);
            var inputs = [];
            for (var j = 0; j < node.inputsLength(); j++) {
                inputs.push(node.inputs(j));
            }
            var outputs = [];
            for (var j = 0; j < node.outputsLength(); j++) {
                outputs.push(node.outputs(j));
            }
            console.log(this.getNodeOperator(node) + ' [' + inputs.join(',') + '] -> [' + outputs.join(',') + ']');
        } */
        var results = [];
        for (var i = 0; i < this._graph.operatorsLength(); i++) {
            var node = this._graph.operators(i);
            results.push(new TensorFlowLiteNode(this, node));
        } 
        return results;
    }

    getInitializer(tensorIndex) {
        var initializer = this._initializerMap[tensorIndex];
        return initializer ? initializer : null;
    }
}

class TensorFlowLiteNode {

    constructor(graph, node) {
        this._graph = graph;
        this._node = node;
    }

    get operator() {
        if (!this._operator) {
            var operatorCodeList = this._graph.model._operatorCodeList;
            var opcodeIndex = this._node.opcodeIndex();
            this._operator = (opcodeIndex < operatorCodeList.length) ?
                operatorCodeList[opcodeIndex] :
                ('(' + opcodeIndex.toString() + ')');
        }
        return this._operator;
    }

    get name() {
        return null;
    }

    get primitive() {
        return null;
    }

    get documentation() {
        return null;
    }

    get domain() {
        return null;
    }

    get category() {
        return TensorFlowLiteOperatorMetadata.operatorMetadata.getOperatorCategory(this.operator);
    }

    get inputs() {
        var results = [];
        var graph = this._graph._graph;
        var node = this._node;
        for (var i = 0; i < node.inputsLength(); i++) {
            var tensorIndex = node.inputs(i);
            var tensor = graph.tensors(tensorIndex);
            var input = {
                name: TensorFlowLiteOperatorMetadata.operatorMetadata.getInputName(this.operator, i),
                connections: []
            };
            var connection = {};
            connection.id = tensorIndex.toString();
            connection.type = TensorFlowLiteTensor.formatTensorType(tensor);
            var initializer = this._graph.getInitializer(tensorIndex);
            if (initializer) {
                connection.initializer = initializer;
            }
            input.connections.push(connection);
            results.push(input);
        }
        return results;
    }

    get outputs() {
        var results = [];
        var graph = this._graph._graph;
        var node = this._node;
        for (var i = 0; i < node.outputsLength(); i++) {
            var tensorIndex = node.outputs(i);
            var tensor = graph.tensors(tensorIndex);
            var output = {
                name: TensorFlowLiteOperatorMetadata.operatorMetadata.getOutputName(this.operator, i),
                connections: []
            };
            var connection = {};
            connection.id = tensorIndex.toString();
            connection.type = TensorFlowLiteTensor.formatTensorType(tensor);
            var initializer = this._graph.getInitializer(tensorIndex);
            if (initializer) {
                connection.initializer = initializer;
            }
            output.connections.push(connection);
            results.push(output);
        }
        return results;
    }

    get dependencies() {
        return [];
    }

    get attributes() {
        if (!this._attributes) {
            this._attributes = [];
            var metadata = TensorFlowLiteOperatorMetadata.operatorMetadata;
            var node = this._node;
            var operator = this._operator;
            var optionsTypeName = 'tflite.' + operator + 'Options';
            var optionsType = eval(optionsTypeName);
            if (typeof optionsType === 'function') {
                var options = eval('new ' + optionsTypeName + '()');
                node.builtinOptions(options);
                var attributeNames = [];
                Object.keys(Object.getPrototypeOf(options)).forEach(function (attributeName) {
                    if (attributeName != '__init') {
                        attributeNames.push(attributeName);
                    }
                });
                attributeNames.forEach((attributeName) => {
                    if (options[attributeName] && typeof options[attributeName] == 'function') {
                        var attributeValue = options[attributeName]();
                        attributeValue = this.formatAttributeValue(attributeValue, attributeName, optionsTypeName);
                        if (attributeValue != null) {
                            attributeName = this.formatAttributeName(attributeName);
                            this._attributes.push({
                                name: attributeName,
                                type: metadata.getAttributeType(operator, attributeName),
                                value: attributeValue
                            });
                        }
                    }
                });
            }
        }
        return this._attributes;
    }

    formatAttributeName(name) {
        var lower = name.toLowerCase();
        var result = '';
        for (var i = 0; i < name.length; i++) {
            result += (name[i] == lower[i]) ? name[i] : ('_' + lower[i]);
        }
        return result;
    }

    formatAttributeValue(attributeValue, attributeName, optionsTypeName) {
        if (!TensorFlowLiteNode._optionsEnumTypeMap) {
            TensorFlowLiteNode._optionsEnumTypeMap = {};
            var optionsEnumTypeMap = TensorFlowLiteNode._optionsEnumTypeMap;
            optionsEnumTypeMap['tflite.Conv2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.Pool2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.DepthwiseConv2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.LSHProjectionOptions'] = {
                type: { type: tflite.LSHProjectionType }
            };
            optionsEnumTypeMap['tflite.SVDFOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.RNNOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.FullyConnectedOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.ConcatenationOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.AddOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.MulOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.L2NormOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.LSTMOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.EmbeddingLookupSparseOptions'] = {
                combiner: { type: tflite.CombinerType }
            };
        }
        var optionsEnumType = TensorFlowLiteNode._optionsEnumTypeMap[optionsTypeName];
        if (optionsEnumType) {
            var attributeType = optionsEnumType[attributeName];
            if (attributeType) {
                var map = attributeType.map;
                if (!map) {
                    map = {};
                    var enumType = attributeType.type;
                    Object.keys(enumType).forEach(function (key) {
                        map[enumType[key]] = key;
                    });
                    attributeType.map = map;
                }
                var enumValue = map[attributeValue];
                if (enumValue) {
                    var defaultValue = attributeType.default;
                    if (defaultValue && defaultValue == enumValue) {
                        return null;
                    }
                    return enumValue;
                }
            }
        }
        return attributeValue;
    }
}

class TensorFlowLiteTensor {

    constructor(tensor, buffer, index) {
        this._id = index;
        this._tensor = tensor;
        this._buffer = buffer;
    }

    get id() {
        return this._id.toString();
    }

    get name() {
        return this._tensor.name();
    }

    get type() {
        return TensorFlowLiteTensor.formatTensorType(this._tensor);
    }

    get quantization() {
        var quantization = this._tensor.quantization();
        if (quantization && quantization.scaleLength() == 1 && quantization.zeroPointLength() == 1) {
            var scale = quantization.scale(0);
            if (scale != 0) {
                var zeroPoint = quantization.zeroPoint(0).toFloat64();
                return 'f = ' + scale.toString() + ' * ' + (zeroPoint != 0 ? ('(q - ' + zeroPoint.toString() + ')') : 'q');
            }
        }
        return null;
    }

    get value() {

        if (this._buffer.dataLength() == 0) {
            return 'Tensor data is empty.';
        }

        var array = this._buffer.dataArray();
        this._data = new DataView(array.buffer, array.byteOffset, array.byteLength);

        if (this._tensor.type() == tflite.TensorType.STRING) {
            var utf8Decoder = window.TextDecoder ? new TextDecoder('utf-8') : null;
            var offset = 0;
            var count = this._data.getInt32(0, true);
            offset += 4;
            var offsetTable = [];
            for (var j = 0; j < count; j++) {
                offsetTable.push(this._data.getInt32(offset, true));
                offset += 4;
            }
            offsetTable.push(array.length);
            var stringTable = [];
            for (var k = 0; k < count; k++) {
                var textArray = array.subarray(offsetTable[k], offsetTable[k + 1]);
                if (utf8Decoder) {
                    stringTable.push(utf8Decoder.decode(textArray));
                }
                else {
                    stringTable.push(String.fromCharCode.apply(null, textArray));
                }
            }
            this._data = stringTable;
        }

        this._index = 0;                
        this._count = 0;
        var result = this.read(0);

        delete this._index;
        delete this._count;  
        delete this._data;
        delete this._utf8Decoder;

        return JSON.stringify(result, null, 4);
    }

    read(dimension) {
        var size = this._tensor.shape(dimension);
        var results = [];
        if (dimension == this._tensor.shapeLength() - 1) {
            for (var i = 0; i < size; i++) {
                if (this._count > 10000) {
                    results.push('...');
                    return results;
                }
                switch (this._tensor.type())
                {
                    case tflite.TensorType.FLOAT32:
                        results.push(this._data.getFloat32(this._index, true));
                        this._index += 4;
                        this._count++;
                        break;
                    case tflite.TensorType.FLOAT16:
                        results.push(TensorFlowLiteTensor.decodeNumberFromFloat16(this._data.getUint16(this._index, true)));
                        this._index += 2;
                        this._count++;
                        break;
                    case tflite.TensorType.UINT8:
                        results.push(this._data.getUint8(this._index));
                        this._index += 1;
                        this._count++;
                        break;
                    case tflite.TensorType.INT32:
                        results.push(this._data.getInt32(this._index, true));
                        this._index += 4;
                        this._count++;
                        break;
                    case tflite.TensorType.INT64:
                        results.push(new Int64(this._data.getInt64(this._index, true)));
                        this._index += 8;
                        this._count++;
                        break;
                    case tflite.TensorType.STRING:
                        results.push(this._data[this._index++]);
                        this._count++;
                        break;
                    default:
                        debugger;
                        break;
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                if (this._count > 10000) {
                    results.push('...');
                    return results;
                }
                results.push(this.read(dimension + 1));
            }
        }
        return results;
    }

    static decodeNumberFromFloat16(value) {
        var s = (value & 0x8000) >> 15;
        var e = (value & 0x7C00) >> 10;
        var f = value & 0x03FF;
        if(e == 0) {
            return (s ? -1 : 1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
        }
        else if (e == 0x1F) {
            return f ? NaN : ((s ? -1 : 1) * Infinity);
        }
        return (s ? -1 : 1) * Math.pow(2, e-15) * (1 + (f / Math.pow(2, 10)));
    }

    static formatTensorType(tensor) {
        if (!TensorFlowLiteTensor.tensorTypeMap)
        {
            var map = {};
            map[tflite.TensorType.FLOAT32] = 'float';
            map[tflite.TensorType.FLOAT16] = 'float16';
            map[tflite.TensorType.INT32] = 'int32';
            map[tflite.TensorType.UINT8] = 'byte';
            map[tflite.TensorType.INT64] = 'int64';
            map[tflite.TensorType.STRING] = 'string';
            TensorFlowLiteTensor.tensorTypeMap = map;
        }
        var result = TensorFlowLiteTensor.tensorTypeMap[tensor.type()]; 
        if (!result) {
            debugger;
            result = '?';
        }
        var shapeLength = tensor.shapeLength();
        if (shapeLength > 0) {
            var dimensions = [];
            for (var i = 0; i < shapeLength; i++) {
                dimensions.push(tensor.shape(i).toString());
            }
            result += '[' + dimensions.join(',') + ']';
        }
        return result;
    }

}

class TensorFlowLiteOperatorMetadata {

    static open(host, callback) {
        if (TensorFlowLiteOperatorMetadata.operatorMetadata) {
            callback(null, TensorFlowLiteOperatorMetadata.operatorMetadata);
        }
        else {
            host.request('/tflite-operator.json', (err, data) => {
                if (err == null) {
                    TensorFlowLiteOperatorMetadata.operatorMetadata = new TensorFlowLiteOperatorMetadata(data);
                }
                callback(null, TensorFlowLiteOperatorMetadata.operatorMetadata);
            });    
        }
    }

    constructor(data) {
        this._map = {};
        var items = JSON.parse(data);
        if (items) {
            items.forEach((item) => {
                if (item.name && item.schema)
                {
                    this._map[item.name] = item.schema;
                }
            });
        }

        this._categoryMap = {
            'Conv2D': 'Layer',
            'DepthwiseConv2D': 'Layer',
            'Softmax': 'Activation',
            'Reshape': 'Shape',
            'Normalize': 'Normalization',
            'AveragePool2D': 'Pool',
            'MaxPool2D': 'Pool',
            'Concatenation': 'Tensor',            
            // 'LSHProjection': 
            // 'Predict': 
            // 'HashtableLookup':
            // 'ExtractFeatures': 
            // 'SkipGram':
        };
    }

    getInputName(operator, index) {
        var schema = this._map[operator];
        if (schema) {
            var inputs = schema.inputs;
            if (inputs && index < inputs.length) {
                var input = inputs[index];
                if (input) {
                    if (!input.option || input.option != 'variadic') {
                        var name = input.name;
                        if (name) {
                            return name;
                        }
                    }
                } 
            }
        }
        return "(" + index.toString() + ")";
    }

    getOutputName(operator, index) {
        var schema = this._map[operator];
        if (schema) {
            var outputs = schema.outputs;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    if (!output.option || output.option != 'variadic') {
                        var name = output.name;
                        if (name) {
                            return name;
                        }
                    }
                } 
            }
        }
        return "(" + index.toString() + ")";
    }

    getAttributeType(operator, name) {
        var schema = this._map[operator];
        if (schema) {
            var attributeMap = schema.attributeMap;
            if (!attributeMap) {
                attributeMap = {};
                if (schema.attributes) {
                    schema.attributes.forEach((attribute) => {
                        attributeMap[attribute.name] = attribute;
                    });
                }
                schema.attributeMap = attributeMap;
            }
            var attributeEntry = attributeMap[name];
            if (attributeEntry) { 
                return attributeEntry.type;
            }
        }
        return '';
    }

    getOperatorCategory(operator) {
        var category = this._categoryMap[operator];
        if (category) {
            return category;
        }
        return null;
    }
}