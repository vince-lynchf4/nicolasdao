/**
 * Copyright (c) 2018, Neap Pty Ltd.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
*/
const _ = require('lodash')
const { chain, log, escapeGraphQlSchema, getQueryAST, buildQuery, newShortId } = require('./utilities')
const { extractGraphMetadata, removeGraphMetadata } = require('./graphmetadata')

const GENERICTYPEREGEX = /<(.*?)>/
const TYPENAMEREGEX = /type\s(.*?){/
const INPUTNAMEREGEX = /input\s(.*?){/
const ENUMNAMEREGEX = /enum\s(.*?){/
const INTERFACENAMEREGEX = /interface\s(.*?){/
const ABSTRACTNAMEREGEX = /abstract\s(.*?){/
const INHERITSREGEX = /inherits\s+\w+(?:\s*,\s*\w+)*/g
const IMPLEMENTSREGEX = /implements\s(.*?)\{/mg
const PROPERTYPARAMSREGEX = /\((.*?)\)/

const TYPE_REGEX = { regex: /(extend type|type)\s(.*?){(.*?)░([^#]*?)}/mg, type: 'type' }
const INPUT_REGEX = { regex: /(extend input|input)\s(.*?){(.*?)░([^#]*?)}/mg, type: 'input' }
const ENUM_REGEX = { regex: /enum\s(.*?){(.*?)░([^#]*?)}/mg, type: 'enum' }
const INTERFACE_REGEX = { regex: /(extend interface|interface)\s(.*?){(.*?)░([^#]*?)}/mg, type: 'interface' }
const ABSTRACT_REGEX = { regex: /(extend abstract|abstract)\s(.*?){(.*?)░([^#]*?)}/mg, type: 'abstract' }
const SCALAR_REGEX = { regex: /(.{1}|.{0})scalar\s(.*?)([^\s]*?)(?![a-zA-Z0-9])/mg, type: 'scalar' }
const UNION_REGEX = { regex: /(.{1}|.{0})union([^\n]*?)\n/gm, type: 'union' }

const carrReturnEsc = '░'
const tabEsc = '_t_'

let _s = {}
const escapeGraphQlSchemaPlus = (sch, cr, t) => {
	if (!sch)
		return sch

	if (!_s[sch])
		_s[sch] = escapeGraphQlSchema(sch, cr, t)

	return _s[sch]
}

/**
 * Gets a first rough breakdown of the string schema
 * @param  {String} sch Original GraphQl Schema
 * @return {Array}      Using regex, the interfaces, types, inputs, enums and abstracts entities are isolated
 *                      e.g. [{
 *                      		property: 'type Query { bars: [Bar]! }',
 *                      		block: [ 'bars: [Bar]!' ],
 *                      		extend: false
 *                      	},{
 *                      		property: 'type Bar { id: ID }',
 *                      		block: [ 'id: ID' ],
 *                      		extend: false
 *                      	}]
 */
const getSchemaBits = (sch='') => {
	const escapedSchemaWithComments = escapeGraphQlSchemaPlus(sch, carrReturnEsc, tabEsc)
	const { schema:escSchemaWithEscComments, tokens } = (escapedSchemaWithComments.match(/#(.*?)░/g) || []).reduce((acc,m) => {
		const commentToken = `#${newShortId()}░`
		acc.schema = acc.schema.replace(m, commentToken)
		acc.tokens.push({ id: commentToken, value: m })
		return acc
	}, { schema: escapedSchemaWithComments, tokens: [] })
	// We append '\n' to help isolating the 'union'
	const schemaWithoutComments = ' ' + sch.replace(/#(.*?)\n/g, '') + '\n'
	const escapedSchemaWithoutComments = escapeGraphQlSchemaPlus(schemaWithoutComments, carrReturnEsc, tabEsc)
	return _.flatten([TYPE_REGEX, INPUT_REGEX, ENUM_REGEX, INTERFACE_REGEX, ABSTRACT_REGEX, SCALAR_REGEX, UNION_REGEX]
	.map(rx =>
		// 1. Apply the regex matching
		chain((
			rx.type == 'scalar' ? escapedSchemaWithoutComments :
			rx.type == 'union' ? schemaWithoutComments :
			escSchemaWithEscComments).match(rx.regex) || [])
		// 2. Filter the right matches
		.next(regexMatches =>
			rx.type == 'scalar' ? regexMatches.filter(m => m.indexOf('scalar') == 0 || m.match(/^(?![a-zA-Z0-9])/)) :
			rx.type == 'union' ? regexMatches.filter(m => m.indexOf('union') == 0 || m.match(/^(?![a-zA-Z0-9])/)) : regexMatches)
		// 3. Replace the excaped comments with their true value
		.next(regexMatches => regexMatches.map(b => (b.match(/#(.*?)░/g) || []).reduce((acc,m) => {
			const value = (tokens.find(t => t.id == m) || {}).value
			return value ? acc.replace(m, value) : acc
		}, b)))
		// 4. Breackdown each match into 'property', 'block' and 'extend'
		.next(regexMatches => {
			const transform =
				rx.type == 'scalar' ? breakdownScalarBit :
				rx.type == 'union' ? breakdownUnionBit : breakdownSchemabBit
			return regexMatches.map(str => transform(str))
		})
		.val()))
}

const breakdownSchemabBit = str => {
	const blockMatch = str.match(/{(.*?)░([^#]*?)}/)
	if (!blockMatch) {
		const msg = 'Schema error: Missing block'
		log(msg)
		throw new Error(msg)
	}

	const block = _.toArray(_(blockMatch[0].replace(/_t_/g, '').replace(/^{/,'').replace(/}$/,'').split(carrReturnEsc).map(x => x.trim())).filter(x => x != ''))
	const rawProperty = str.split(carrReturnEsc).join(' ').split(tabEsc).join(' ').replace(/ +(?= )/g,'').trim()
	const { property, extend } = rawProperty.indexOf('extend') == 0
		? { property: rawProperty.replace('extend ', ''), extend: true }
		: { property: rawProperty, extend: false }
	return { property, block, extend }
}

const breakdownScalarBit = str => {
	const block = (str.split(' ').slice(-1) || [])[0]
	return { property: `scalar ${block}`, block: block, extend: false }
}

const breakdownUnionBit = str => {
	const block = str.replace(/(^union\s|\sunion\s|\n)/g, '').trim()
	return { property: `union ${block}`, block: block, extend: false }
}

const getSchemaEntity = firstLine =>
	firstLine.indexOf('type') == 0 ? { type: 'TYPE', name: firstLine.match(/type\s+(.*?)\s+.*/)[1].trim() } :
	firstLine.indexOf('enum') == 0 ? { type: 'ENUM', name: firstLine.match(/enum\s+(.*?)\s+.*/)[1].trim() } :
	firstLine.indexOf('input') == 0 ? { type: 'INPUT', name: firstLine.match(/input\s+(.*?)\s+.*/)[1].trim() } :
	firstLine.indexOf('interface') == 0 ? { type: 'INTERFACE', name: firstLine.match(/interface\s+(.*?)\s+.*/)[1].trim() } :
	firstLine.indexOf('union') == 0 ? { type: 'UNION', name: firstLine.match(/union\s+(.*?)\s+.*/)[1].trim() } :
	firstLine.indexOf('scalar') == 0 ? { type: 'SCALAR', name: firstLine.match(/scalar\s+(.*?)\s+.*/)[1].trim() } :
	{ type: null, name: null }

const getCommentsBits = (sch) =>
	(escapeGraphQlSchemaPlus(sch, carrReturnEsc, tabEsc).match(/#(.*?)░([^#]*?)({|:)/g) || [])
	.filter(x => x.match(/{$/))
	.map(c => {
		const parts = _(c.split(carrReturnEsc).map(l => l.replace(/_t_/g, '    ').trim())).filter(x => x != '')
		const hashCount = parts.reduce((a,b) => a + (b.indexOf('#') == 0 ? 1 : 0), 0)
		return { text: parts.initial(), property: getSchemaEntity(parts.last()), comments: hashCount == parts.size() - 1 }
	})
	.filter(x => x.comments).map(x => ({ text: x.text.join('\n'), property: x.property }))

/**
 * Gets the alias for a generic type (e.g. Paged<Product> -> PagedProduct)
 * @param  {String} genName e.g. Paged<Product>
 * @return {String}         e.g. PagedProduct
 */
const genericDefaultNameAlias = genName => {
	if (!genName)
		return ''
	const m = genName.match(GENERICTYPEREGEX)
	if (m) {
		const parts = genName.split(m[0])
		return `${parts[0]}${m[1].split(',').map(x => x.trim()).join('')}`
	} else
		return genName
}

/**
 * Example: [T] -> [User], or T -> User or Toy<T> -> Toy<User>
 * @param  {string} genericType   	e.g. 'Toy<T>', 'Toy<T,U>'
 * @param  {array}  genericLetters 	e.g. ['T'], ['T','U']
 * @param  {string} concreteType  	e.g. 'User', 'User,Product'
 * @return {string}               	e.g. 'Toy<User>', 'Toy<User,Product>'
 */
const replaceGenericWithType = (genericType, genericLetters, concreteType) =>
	chain({ gType: genericType.replace(/\s/g, ''), gLetters: genericLetters.map(x => x.replace(/\s/g, '')), cTypes: concreteType.split(',').map(x => x.replace(/\s/g, '')) })
	.next(({ gType, gLetters, cTypes }) => {
		const cTypesLength = cTypes.length
		const genericTypeIsArray = gType.indexOf('[') == 0 && gType.indexOf(']') > 0
		const endingChar = gType.match(/!$/) ? '!' : ''
		if (gLetters.length != cTypesLength)
			throw new Error(`Invalid argument exception. Mismatch between the number of types in 'genericLetters' (${genericLetters.join(',')}) and 'concreteType' (${concreteType}).`)
		// e.g. genericType = 'T', genericLetters = ['T'], concreteType = 'User' -> resp = 'User'
		if (gLetters.length == 1 && gType.replace(/!$/, '') == gLetters[0])
			return  `${cTypes[0]}${endingChar}`
		// e.g. genericType = 'Paged<T>' or '[Paged<T>]'
		else if (gType.indexOf('<') > 0 && gType.indexOf('>') > 0) {
			const type = genericTypeIsArray ? gType.match(/\[(.*?)\]/)[1] : gType
			const typeName = type.match(/.*</)[0].replace(/<$/,'').trim() // e.g. 'Toy'
			const types = type.match(/<(.*?)>/)[1].split(',').map(x => x.trim())
			if (types.length != gLetters.length)
				throw new Error(`Invalid argument exception. Mismatch between the number of types in 'genericLetters' (${genericLetters.join(',')}) and 'genericType' (${genericType}).`)

			const matchingConcreteTypes = types.map(t => {
				for(let i=0;i<cTypesLength;i++) {
					if (gLetters[i] == t)
						return cTypes[i]
				}
				throw new Error(`Invalid argument exception. Mismatch types between the 'genericType' (${genericType}) and the allowed types 'genericLetters' (${genericLetters.join(',')}).`)
			})
			const result = `${typeName}<${matchingConcreteTypes.join(',')}>`

			return genericTypeIsArray ? `[${result}]${endingChar}` : `${result}${endingChar}`
		} else { // e.g. genericType = 'T' or '[T]'
			const type = genericTypeIsArray ? gType.match(/\[(.*?)\]/)[1] : gType
			const matchingConcreteTypes = type.split(',').map(t => {
				const isRequired = /!$/.test(t)
				t = (isRequired ? t.replace(/!$/, '') : t).trim()
				for(let i=0;i<cTypesLength;i++) {
					if (gLetters[i] == t)
						return `${cTypes[i]}${isRequired ? '!' : ''}`
				}
				throw new Error(`Invalid argument exception. Mismatch types between the 'genericType' (${genericType}) and the allowed types 'genericLetters' (${genericLetters.join(',')}).`)
			})
			const result = matchingConcreteTypes.join(',')
			return genericTypeIsArray ? `[${result}]${endingChar}` : `${result}${endingChar}`
		}
	})
	.val()

let memoizedGenericNameAliases = {}
const getAliasName = (genericType, metadata) => memoizedGenericNameAliases[genericType] || chain(genericType.match(/.*</)[0])
	.next(genericStart => getAllAliases(metadata).find(x => x.schemaName.indexOf(genericStart) == 0))
	.next(aliasObj => {
		const alias = aliasObj && aliasObj.body ? getGenericAlias(aliasObj.body)(genericType) : genericDefaultNameAlias(genericType)
		memoizedGenericNameAliases[genericType] = alias
		return alias
	})
	.val()

let memoizedAliases = null
const getAllAliases = metadata => memoizedAliases || chain((metadata || []).filter(x => x.name == 'alias')).next(aliases => {
	memoizedAliases = aliases
	return aliases
}).val()

let memoizedGenericSchemaObjects = {}
/**
 * Get all the type details
 *
 * @param  {String}  t            				Type (e.g. Paged<Product>)
 * @param  {Array}   metadata     				Array of metadata objects
 * @param  {Array}   genericParentTypes 		Array of string representing the types (e.g. ['T', 'U']) of the generic parent type
 *                                  	     	of that type if that type was extracted from a block. If this array is null, that
 *                                  	      	means the parent type was not a generic type.
 * @return {String}  result.originName			't'
 * @return {Boolean} result.isGen				Indicates if 't' is a generic type
 * @return {Boolean} result.dependsOnParent		Not null if 't' is a generic. Indicates if the generic type of 't' depends
 *                                           	on its parent's type (if true, then that means the parent is itself a generic)
 * @return {Array} 	 result.metadata			'metadata'
 * @return {Array} 	 result.genericParentTypes	If the parent is a generic type, then ths array contains contain all the
 *                                             	underlying types.
 * @return {String}  result.name				If 't' is not a generic type then 't' otherwise determine what's new name.
 */
const getTypeDetails = (t, metadata, genericParentTypes) => chain((t.match(GENERICTYPEREGEX) || [])[1])
	.next(genTypes => {
		const isGen = genTypes ? true : false
		const genericTypes = isGen ? genTypes.split(',').map(x => x.trim()) : null
		const originName = t.replace(/@.+/, '').trim()
		const directive = (t.match(/@.+/) || [])[0]
		const endingChar = originName.match(/!$/) ? '!' : ''
		const dependsOnParent = isGen && genericParentTypes && genericParentTypes.length > 0 && genericTypes.some(x => genericParentTypes.some(y => x == y))
		return {
			originName,
			directive,
			isGen,
			dependsOnParent,
			metadata,
			genericParentTypes,
			name: isGen && !dependsOnParent ? `${getAliasName(originName, metadata)}${endingChar}` : originName
		}
	})
	.next(result => {
		if (result.isGen && !memoizedGenericSchemaObjects[result.name])
			memoizedGenericSchemaObjects[result.name] = result
		return result
	})
	.val()

/**
 * Transpile parameters if generic types are used in them
 *
 * @param  {String}  params            			Parameters (e.g. (filter: Filtered<Product>)
 * @param  {Array}   metadata     				Array of metadata objects
 * @param  {Array}   genericParentTypes 		Array of string representing the types (e.g. ['T', 'U']) of the generic parent type
 *                                  	     	of that type if that type was extracted from a block. If this array is null, that
 *                                  	      	means the parent type was not a generic type.
 * @return {String}  transpiledParams			The transpiled parameters
 */
const getTranspiledParams = (params, genericParentTypes) => chain(params.split(','))
	.next(genTypes => {
		const transpiledParams = []
		genTypes.forEach(genType => {
			const genericTypeMatches = genType.match(GENERICTYPEREGEX)
            const isGen = !!genericTypeMatches
            const genericTypes = isGen ? genTypes.map(x => x.trim()) : null
			const [ paramName, originName ] = genType.split(':').map(item => item.trim())
            const endingChar = originName.match(/!$/) ? '!' : ''
            const dependsOnParent = isGen && genericParentTypes && genericParentTypes.length > 0 && genericTypes.some(x => genericParentTypes.some(y => x === y))
            const result = {
                paramName,
                originName,
                isGen,
                name: isGen && !dependsOnParent ? `${getAliasName(originName)}${endingChar}` : originName
            }
            if (result.isGen && !memoizedGenericSchemaObjects[result.name])
                memoizedGenericSchemaObjects[result.name] = result
            transpiledParams.push(`${result.paramName}: ${result.name}`)
		})
		return transpiledParams
	})
	.next(result => {
		return result.join(', ')
	})
	.val()

const getPropertyValue = ({ name, params, result }, mapResultName) => {
	const leftPart = `${name}${params ? `(${params})` : ''}`
	let delimiter = ''
	let rightPart = ''
	if (result && result.name) {
		delimiter = ': '
		rightPart = mapResultName ? mapResultName(result.name) : result.name
		if (result.directive)
			rightPart = `${rightPart} ${result.directive}`
	}
	return `${leftPart}${delimiter}${rightPart}`
}

/**
 * Breaks down a string representing a block { ... } into its various parts.
 * @param  {string} blockParts 				String representing your entire block (e.g. { users: User[], posts: Paged<Post> })
 * @param  {object} baseObj
 * @param  {string} baseObj.type 			Type of the object with blockParts (e.g. TYPE, ENUM, ...)
 * @param  {string} baseObj.name 			Name of the object with blockParts
 * @param  {array} 	baseObj.genericTypes 	Array of types if the 'baseObj' is a generic type.
 * @param  {array}  metadata 				Array of object. Each object represents a metadata. Example: { name: 'node', body: '(name:hello)', schemaType: 'PROPERTY', schemaName: 'rating: PostRating!', parent: { type: 'TYPE', name: 'PostUserRating', metadata: [Object] } }
 * @return [{
 *         		comments: string,
 *         		details: {
 *         					name: string,
 *         					metadata: {
 *         						name: string,
 *         						body: string,
 *         						schemaType: string,
 *         						schemaName: string,
 *         						parent: {
 *         							type: string,
 *         							name: string,
 *         							metadata: [Object]
 *         						}
 *         					},
 *         					params: string,
 *         					result: {
 *         						originName: string,
 *         						isGen: boolean,
 *         						name: string
 *         					}
 *         				},
 *         		value: string
 *         }]             									Property breakdown
 */
const getBlockProperties = (blockParts, baseObj, metadata) =>
	chain(_(metadata).filter(m => m.schemaType == 'PROPERTY' && m.parent && m.parent.type == baseObj.type && m.parent.name == baseObj.name))
	.next(meta => _(blockParts).reduce((a, part) => {
		const p = part.trim()
		const mData = meta.filter(m => m.schemaName == p).first() || null
		if (p.indexOf('#') == 0)
			a.comments.push(p)
		else {
			const prop = p.replace(/ +(?= )/g,'').replace(/,$/, '')
			const paramsMatch  = prop.replace(/@.+/, '').match(PROPERTYPARAMSREGEX)
			const propDetails = paramsMatch
				? chain(prop.split(paramsMatch[0]))
					.next(parts => ({ name: parts[0].trim(), metadata: mData, params: getTranspiledParams(paramsMatch[1], baseObj.genericTypes), result: getTypeDetails((parts[1] || '').replace(':', '').trim(), metadata, baseObj.genericTypes) })).val()
				: chain(prop.split(':'))
					.next(parts => ({ name: parts[0].trim(), metadata: mData, params: null, result: getTypeDetails(parts.slice(1).join(':').trim(), metadata, baseObj.genericTypes) })).val()
			a.props.push({
				comments: a.comments.join('\n    '),
				details: propDetails,
				value: getPropertyValue(propDetails)
			})
			a.comments = []
		}
		return a
	}, { comments:[], props:[] }).props)
	.val()

/**
 * [description]
 * @param  {Array} 	definitions Array of objects ({ property:..., block: [...], extend: ... }) coming from the 'getSchemaBits' function
 * @param  {String} typeName    e.g. 'type' or 'input'
 * @param  {RegExp} nameRegEx   Regex that can extract the specific details of the schema bit (i.e. definitions)
 * @param  {Array} 	metadata    metadata coming from the 'extractGraphMetadata' method.
 * @return {Array}             	Array of objects: Example:
 *                              [{
 *                              	type: 'TYPE',
 *                              	extend: false,
 *                              	name: 'Foo',
 *                              	metadata: null,
 *                              	genericType: null,
 *                              	blockProps: [ { comments: '', details: [Object], value: 'id: String!' } ],
 *                              	inherits: null,
 *                              	implements: null },
 *                              {
 *                              	type: 'TYPE',
 *                              	extend: true,
 *                              	name: 'Query',
 *                              	metadata: null,
 *                              	genericType: null,
 *                              	blockProps: [ { comments: '', details: [Object], value: 'foos: [Foo]!' } ],
 *                              	inherits: null,
 *                              	implements: null
 *                              }]
 */
const getSchemaObject = (definitions, typeName, nameRegEx, metadata) =>
	_.toArray(_(definitions).filter(d => d.property.indexOf(typeName) == 0)
	.map(d => {
		if (typeName == 'scalar')
			return {
				type: 'SCALAR',
				extend: false,
				name: d.block,
				metadata: null,
				genericType: false,
				blockProps: [],
				inherits: null,
				implements: null
			}
		else if (typeName == 'union')
			return {
				type: 'UNION',
				extend: false,
				name: d.block,
				metadata: null,
				genericType: false,
				blockProps: [],
				inherits: null,
				implements: null
			}
		else {
			const typeDefMatch = d.property.match(/(.*?){/)
			if (!typeDefMatch || typeDefMatch[0].indexOf('#') >= 0) throw new Error(`Schema error: Syntax error in '${d.property}'. Cannot any find schema type definition.`)
			const typeDef = typeDefMatch[0]
			const nameMatch = typeDef.match(nameRegEx)
			if (!nameMatch) throw new Error(`Schema error: ${typeName} with missing name.`)
			const name = nameMatch[1].trim().split(' ')[0]
			const genericTypeMatch = name.match(GENERICTYPEREGEX)
			const isGenericType = genericTypeMatch ? genericTypeMatch[1] : null
			const inheritsMatch = typeDef.match(INHERITSREGEX)
			const superClass = inheritsMatch && inheritsMatch[0].replace('inherits', '').trim().split(',').map(v => v.trim()) || null
			const implementsMatch = typeDef.match(IMPLEMENTSREGEX)
			const directive = (typeDef.match(/@[a-zA-Z0-9_]+(.*?)$/) || [''])[0].trim().replace(/{$/, '').trim() || null

			const _interface = implementsMatch
				? implementsMatch[0].replace('implements ', '').replace('{', '').split(',').map(x => x.trim().split(' ')[0])
				: null

			const objectType = typeName.toUpperCase()
			const metadat = metadata
				? _(metadata).filter(m => m.schemaType == objectType && m.schemaName == name).first() || null
				: null

			const genericTypes = isGenericType ? isGenericType.split(',').map(x => x.trim()) : null
			const baseObj = { type: objectType, name: name, genericTypes: genericTypes }

			const result = {
				type: objectType,
				extend: d.extend,
				name: name,
				metadata: metadat,
				directive: directive,
				genericType: isGenericType,
				blockProps: getBlockProperties(d.block, baseObj, metadata),
				inherits: superClass,
				implements: _interface
			}
			return result
		}
	}))

const getGenericAlias = s => !s ? genericDefaultNameAlias :
genName => chain(genName.match(GENERICTYPEREGEX)).next(m => m
	? chain(m[1].split(',').map(x => `"${x.trim()}"`).join(',')).next(genericTypeName => eval(s + '(' + genericTypeName + ')')).val()
	: genName).val()

const getInterfaces = (definitions, metadata) => getSchemaObject(definitions, 'interface', INTERFACENAMEREGEX, metadata)

const getAbstracts = (definitions, metadata) => getSchemaObject(definitions, 'abstract', ABSTRACTNAMEREGEX, metadata)

const getTypes = (definitions, metadata) => getSchemaObject(definitions, 'type', TYPENAMEREGEX, metadata)

const getInputs = (definitions, metadata) => getSchemaObject(definitions, 'input', INPUTNAMEREGEX, metadata)

const getEnums = (definitions, metadata) => getSchemaObject(definitions, 'enum', ENUMNAMEREGEX, metadata)

const getScalars = (definitions, metadata) => getSchemaObject(definitions, 'scalar', null, metadata)

const getUnions = (definitions, metadata) => getSchemaObject(definitions, 'union', null, metadata)

let memoizedExtendedObject = {}
const getObjWithExtensions = (obj, schemaObjects) => {
	if (obj && schemaObjects && obj.inherits) {


		const key = `${obj.type}_${obj.name}_${obj.genericType}`
		if (memoizedExtendedObject[key]) return memoizedExtendedObject[key]

		var superClass = schemaObjects.filter(function(x) {
			return obj.inherits.indexOf(x.name) > -1
		}).value()
		var superClassNames = schemaObjects.map(function(x) {
			return x.name
		}).value()
		//find missing classes
		var missingClasses = _.difference(obj.inherits, superClassNames)

		missingClasses.forEach(function(c){
			throw new Error('Schema error: ' + obj.type.toLowerCase() + ' ' + obj.name + ' cannot find inherited ' + obj.type.toLowerCase() + ' ' + c)
		})

		const superClassesWithInheritance = superClass.map(function(subClass){

			if (!inheritingIsAllowed(obj, subClass)){
				throw new Error('Schema error: ' + obj.type.toLowerCase() + ' ' + obj.name + ' cannot inherit from ' + subClass.type + ' ' + subClass.name + '.')  
			}            
			return getObjWithExtensions(subClass, schemaObjects)
		})

		const objWithInheritance = {
			type: obj.type,
			name: obj.name,
			genericType: obj.genericType,
			originalBlockProps: obj.blockProps,
			metadata: obj.metadata || _.last(superClassesWithInheritance).metadata || null,
			directive: obj.directive,
			implements: _.toArray(_.uniq(_.concat(obj.implements, superClassesWithInheritance.implements).filter(function(x) {
				return x
			}))),
			inherits: superClassesWithInheritance,
			blockProps: (superClassesWithInheritance instanceof Array ?
				_.toArray(_.flatten(_.concat(_.flatten(superClassesWithInheritance.map(function(subClass){
				return subClass.blockProps
			})), obj.blockProps))):
				_.toArray(_.flatten(_.concat(superClassesWithInheritance.blockProps, obj.blockProps)))
			)
		}

		memoizedExtendedObject[key] = objWithInheritance
		return getObjWithInterfaces(objWithInheritance, schemaObjects)
	}
	else
		return getObjWithInterfaces(obj)
}

const inheritingIsAllowed = (obj, subClass) => {
	if (obj.type === 'TYPE'){
		return subClass.type === 'TYPE' || subClass.type === 'INTERFACE'
	}else {
		return obj.type === subClass.type
	}
}

const getObjWithInterfaces = (obj, schemaObjects) => {
	if (obj && schemaObjects && obj.implements && obj.implements.length > 0) {
		const interfaceWithAncestors = _.toArray(_.uniq(_.flatten(_.concat(obj.implements.map(i => getInterfaceWithAncestors(i, schemaObjects))))))
		return {
			type: obj.type,
			name: obj.name,
			genericType: obj.genericType,
			originalBlockProps: obj.blockProps,
			metadata: obj.metadata,
			implements: interfaceWithAncestors,
			inherits: obj.inherits,
			blockProps: obj.blockProps
		}
	}
	else
		return obj
}

let memoizedInterfaceWithAncestors = {}
const getInterfaceWithAncestors = (_interface, schemaObjects) => {
	if (memoizedInterfaceWithAncestors[_interface]) return memoizedInterfaceWithAncestors[_interface]
	const interfaceObj = schemaObjects.filter(x => x.name == _interface).first()
	if (!interfaceObj) throw new Error(`Schema error: interface ${_interface} is not defined.`)
	if (interfaceObj.type != 'INTERFACE') throw new Error(`Schema error: Schema property ${_interface} is not an interface. It cannot be implemented.`)

	const interfaceWithAncestors = interfaceObj.implements && interfaceObj.implements.length > 0
		? _.toArray(_.uniq(_.flatten(_.concat(
			[_interface],
			interfaceObj.implements,
			interfaceObj.implements.map(i => getInterfaceWithAncestors(i, schemaObjects))))))
		: [_interface]

	memoizedInterfaceWithAncestors[_interface] = interfaceWithAncestors
	return interfaceWithAncestors
}

const addComments = (obj, comments) => {
	obj.comments = _(comments).filter(c => c.property.type == obj.type && c.property.name == obj.name).map(x => x.text).first()
	return obj
}

const parseSchemaObjToString = (comments, type, name, _implements, blockProps, extend=false, directive) =>
	[
		`${comments && comments != '' ? `\n${comments}` : ''}`,
		`${extend ? 'extend ' : ''}${type.toLowerCase()} ${name.replace('!', '')}${_implements && _implements.length > 0 ? ` implements ${_implements.join(', ')}` : ''} ${blockProps.some(x => x) ? `${directive ? ` ${directive} ` : ''}{`: ''} `,
		blockProps.map(prop => `    ${prop.comments != '' ? `${prop.comments}\n    ` : ''}${prop.value}`).join('\n'),
		blockProps.some(x => x) ? '}': ''
	].filter(x => x).join('\n')

/**
 * Tests if the type is a generic type based on the value of genericLetter
 *
 * @param  {String} type          e.g. 'Paged<T>', '[T]', 'T', 'T!'
 * @param  {String} genericLetter e.g. 'T', 'T,U'
 * @return {Boolean}              e.g. if type equals 'Paged<T>' or '[T]' and genericLetter equals 'T' then true.
 */
const SANITIZE_GEN_TYPE_REGEX = /^\[|\s|\](\s*)(!*)(\s*)$|!/g
const isTypeGeneric = (type, genericLetter) => {
	const sanitizedType = type ? type.replace(SANITIZE_GEN_TYPE_REGEX, '') : type
	const sanitizedgenericLetter = genericLetter ? genericLetter.replace(SANITIZE_GEN_TYPE_REGEX, '') : genericLetter
	if (!sanitizedType || !sanitizedgenericLetter)
		return false
	else if (sanitizedType == sanitizedgenericLetter)
		return true
	else if (sanitizedType.indexOf('<') > 0 && sanitizedType.indexOf('>') > 0) {
		const genericLetters = sanitizedgenericLetter.split(',')
		return (sanitizedType.match(/<(.*?)>/) || [null, ''])[1].split(',').some(x => genericLetters.some(y => y == x.trim()))
	}
	else
		return sanitizedgenericLetter.split(',').some(x => x.trim() == sanitizedType)
}

const createNewSchemaObjectFromGeneric = ({ originName, isGen, name }, schemaBreakDown, memoizedNewSchemaObjectFromGeneric) => {
	if (!memoizedNewSchemaObjectFromGeneric)
		throw new Error('Missing required argument. \'memoizedNewSchemaObjectFromGeneric\' is required.')
	if (isGen && memoizedNewSchemaObjectFromGeneric[name])
		return memoizedNewSchemaObjectFromGeneric[name]
	else if (isGen) {
		const genObjName = chain(originName.split('<')).next(parts => `${parts[0]}<`).val()
		const concreteType = (originName.match(/<(.*?)>/) || [null, null])[1]
		if (!concreteType) throw new Error(`Schema error: Cannot find generic type in object ${originName}`)
		const baseGenObj = schemaBreakDown.find(x => x.name.indexOf(genObjName) == 0)
		if (!baseGenObj) throw new Error(`Schema error: Cannot find any definition for generic type starting with ${genObjName}`)
		if (!baseGenObj.genericType) throw new Error(`Schema error: Schema object ${baseGenObj.name} is not generic!`)

		const blockProps = baseGenObj.blockProps.map(prop => {
			let p = prop
			if (isTypeGeneric(prop.details.result.name, baseGenObj.genericType)) {
				let details = {
					name: prop.details.name,
					params: prop.params,
					result: {
						originName: prop.details.originName,
						isGen: prop.details.isGen,
						name: replaceGenericWithType(prop.details.result.name, baseGenObj.genericType.split(','), concreteType)
					}
				}
				if (prop.details.result.dependsOnParent) {
					const propTypeIsRequired = prop.details.result.name.match(/!$/)
					// e.g. [Paged<T>]
					const propTypeName = propTypeIsRequired ? prop.details.result.name.replace(/!$/,'') : prop.details.result.name
					const propTypeIsArray = propTypeName.match(/^\[.*\]$/)
					// e.g. [Paged<Product>]
					const originalConcretePropType = replaceGenericWithType(propTypeName, prop.details.result.genericParentTypes, concreteType)
					// e.g. Paged<Product>
					const concretePropType = propTypeIsArray ? originalConcretePropType.replace(/^\[|\]$/g,'') : originalConcretePropType
					const concreteGenProp = getTypeDetails(concretePropType, prop.details.result.metadata)
					// e.g. PagedProduct
					const concreteGenPropName = createNewSchemaObjectFromGeneric(concreteGenProp, schemaBreakDown, memoizedNewSchemaObjectFromGeneric).obj.name
					// e.g. [PagedProduct]
					let originalConcretePropTypeName = propTypeIsArray ? `[${concreteGenPropName}]` : concreteGenPropName
					// e.g. [PagedProduct]!
					originalConcretePropTypeName = originalConcretePropTypeName + (propTypeIsRequired ? '!' : '')
					// e.g. [PagedProduct]! @isAuthenticated
					originalConcretePropTypeName = prop.details.result.directive ? `${originalConcretePropTypeName} ${prop.details.result.directive}` : originalConcretePropTypeName
					details.result = {
						originName: prop.details.result.directive ? `${prop.details.result.name} ${prop.details.result.directive}` : prop.details.result.name,
						isGen: true,
						name: originalConcretePropTypeName
					}
				}

				p = {
					comments: prop.comments,
					details: details,
					value: getPropertyValue(details)
				}
			}

			return p
		})

		const newSchemaObjStr = parseSchemaObjToString(baseGenObj.comments, baseGenObj.type, name, baseGenObj.implements, blockProps)
		const result = {
			obj: {
				comments: baseGenObj.comments,
				type: baseGenObj.type,
				name,
				implements: baseGenObj.implements,
				blockProps: blockProps,
				genericType: null
			},
			stringObj: newSchemaObjStr
		}
		memoizedNewSchemaObjectFromGeneric[name] = result
		return result
	}
	else return { obj: null, stringObj: null }
}

const buildSchemaString = (schemaObjs=[]) => {
	const part_01 = schemaObjs
		.filter(x => !x.genericType && x.type != 'ABSTRACT' && x.type != 'DIRECTIVE')
		.map(obj => parseSchemaObjToString(obj.comments, obj.type, obj.name, obj.implements, obj.blockProps, obj.extend, obj.directive))
		.join('\n')

	const resolvedGenericTypes = {}
	_(memoizedGenericSchemaObjects)
		.filter(x => !x.dependsOnParent)
		.forEach(value => createNewSchemaObjectFromGeneric(value, schemaObjs, resolvedGenericTypes).stringObj)

	const part_02 = _(resolvedGenericTypes).map(x => x.stringObj).join('\n')
	const directives = schemaObjs.filter(x => x.type == 'DIRECTIVE' && x.raw).map(x => x.raw).join('')

	return directives + '\n' + part_01 + part_02
}


/**
 * Breaks down a schema into its bits and pieces.
 * @param  {String}  graphQlSchema
 * @param  {Array}   metadata
 * @param  {Boolean} includeNewGenTypes
 * @return {String}  result.type 		e.g. 'TYPE', 'INTERFACE'
 * @return {Boolean} result.raw
 * @return {Boolean} result.extend
 * @return {String}  result.name
 * @return {String}  result.metadata
 * @return {Boolean} result.genericType
 * @return {String}  result.blockProps
 * @return {Boolean} result.inherits
 * @return {String}  result.implements
 * @return {String}  result.comments
 */
const getSchemaParts = (graphQlSchema, metadata, includeNewGenTypes) => chain(getSchemaBits(graphQlSchema))
	.next(schemaBits => _([getInterfaces, getAbstracts, getTypes, getInputs, getEnums, getScalars, getUnions]
		.reduce((objects, getObjects) => objects.concat(getObjects(schemaBits, metadata)), [])))
	.next(firstSchemaBreakDown => _.toArray(firstSchemaBreakDown
		.map(obj => getObjWithExtensions(obj, firstSchemaBreakDown))
		.map(obj => addComments(obj, getCommentsBits(graphQlSchema)))))
	.next(v => {
		if (includeNewGenTypes){
			const resolvedGenericTypes = {}
			_(memoizedGenericSchemaObjects)
				.filter(x => !x.dependsOnParent)
				.forEach(value => createNewSchemaObjectFromGeneric(value, v, resolvedGenericTypes))

			return v.concat(_.toArray(_(resolvedGenericTypes).map(x => x.obj)))
		} else
			return v
	})
	// Include directives
	.next(v => {
		const directives = (metadata || []).filter(m => m.directive)
		if (directives.length > 0) {
			return v.concat(directives.map(d => ({
				type: 'DIRECTIVE',
				name: d.name,
				raw: (d.body || '').replace(/░/g, '\n'),
				extend: false,
				metadata: null,
				genericType: null,
				blockProps: [],
				inherits: null,
				implements: null,
				comments: undefined
			})))
		} else
			return v
	})
	.val()

const resetMemory = () => {
	_s = {}
	memoizedGenericSchemaObjects = {}
	memoizedExtendedObject = {}
	memoizedInterfaceWithAncestors = {}
	memoizedGenericNameAliases = {}
	memoizedAliases = null
	return 1
}

let graphqls2s = {
	getSchemaAST: graphQlSchema => chain(resetMemory())
		.next(() => removeGraphMetadata(graphQlSchema))
		.next(data => getSchemaParts(data.stdSchema, data.metadata, true))
		.next(v => { resetMemory(); return v })
		.val(),
	transpileSchema: graphQlSchema => chain(resetMemory())
		.next(() => removeGraphMetadata(graphQlSchema))
		.next(data => buildSchemaString(getSchemaParts(data.stdSchema, data.metadata)))
		.next(v => { resetMemory(); return v })
		.val(),
	extractGraphMetadata,
	getGenericAlias,
	getQueryAST,
	buildQuery,
	isTypeGeneric
}

if (typeof(window) != 'undefined') window.graphqls2s = graphqls2s

module.exports.graphqls2s = graphqls2s

